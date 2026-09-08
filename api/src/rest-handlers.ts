import {
  databaseFailureGuidance,
  normalizeProductRoute,
  type ProductRoute,
} from "@machine-memory/contract";
import type { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { JsonValue } from "./json";

const INVALID_JSON_BODY_ERROR = "Invalid JSON request body.";
const INTERNAL_ERROR = "Internal server error.";

export type RestFailure = {
  readonly status: 400 | 500;
  readonly error: string;
  readonly category:
    | "fts-query"
    | "pattern-complexity"
    | "sql-query"
    | "database-schema"
    | "internal";
};

export function classifyRestFailure(cause: unknown): RestFailure {
  const guidance = databaseFailureGuidance(cause);
  if (guidance !== undefined) {
    return {
      status: guidance.correctableInput ? 400 : 500,
      error: guidance.error,
      category: guidance.category,
    };
  }
  return { status: 500, error: INTERNAL_ERROR, category: "internal" };
}

export type RestHandlerFn<R = RuntimeContext> = (
  body: JsonValue,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, R>;

export type RestHandlers<R = RuntimeContext> = {
  readonly expectedToken: Redacted.Redacted;
  readonly handleQuery: RestHandlerFn<R>;
  readonly handleMigration: RestHandlerFn<R>;
  readonly handleMigrationLinks: RestHandlerFn<R>;
  readonly handleVectorizeUpsert: RestHandlerFn<R>;
  readonly handleVectorizeSearch: RestHandlerFn<R>;
  readonly handleVectorizeDelete: RestHandlerFn<R>;
  readonly handleProduct: (
    route: ProductRoute,
    body: JsonValue,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, R>;
};

function catchInternal<R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, R>,
  route: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> {
  return effect.pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        const failure = classifyRestFailure(cause);
        console.error(`REST ${route} failed [${failure.category}].`);
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: failure.error },
          { status: failure.status },
        );
      }),
    ),
  );
}

const KNOWN_ROUTES = new Set([
  "/query",
  "/migrate",
  "/migrate/links",
  "/vectorize/upsert",
  "/vectorize/search",
  "/vectorize/delete",
]);

export function handleRestRequest<R>(
  handlers: RestHandlers<R>,
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> {
  const route = (body: JsonValue) => {
    if (request.url === "/query") {
      return handlers.handleQuery(body);
    }
    if (request.url === "/migrate") {
      return handlers.handleMigration(body);
    }
    if (request.url === "/migrate/links") {
      return handlers.handleMigrationLinks(body);
    }
    if (request.url === "/vectorize/upsert") {
      return handlers.handleVectorizeUpsert(body);
    }
    if (request.url === "/vectorize/delete") {
      return handlers.handleVectorizeDelete(body);
    }
    if (request.url === "/vectorize/search") {
      return handlers.handleVectorizeSearch(body);
    }
    const productRoute = normalizeProductRoute(request.url);
    if (productRoute !== undefined) {
      return handlers.handleProduct(productRoute, body);
    }
    return Effect.succeed(
      HttpServerResponse.jsonUnsafe({ error: "Not found" }, { status: 404 }),
    );
  };

  const guardedRoute = (body: JsonValue) =>
    catchInternal(route(body), request.url);

  return Effect.gen(function* () {
    if (
      request.method !== "POST" ||
      (!KNOWN_ROUTES.has(request.url) &&
        normalizeProductRoute(request.url) === undefined)
    ) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Not found" },
        { status: 404 },
      );
    }

    if (
      request.headers.authorization !==
      `Bearer ${Redacted.value(handlers.expectedToken)}`
    ) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    const bodyResult = yield* request.json.pipe(
      Effect.map((body) => ({
        ok: true as const,
        body: Schema.decodeUnknownSync(Schema.Json)(body),
      })),
      Effect.catchCause(() => Effect.succeed({ ok: false as const })),
    );
    if (!bodyResult.ok) {
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: INVALID_JSON_BODY_ERROR },
        { status: 400 },
      );
    }
    return yield* guardedRoute(bodyResult.body);
  });
}

import {
  databaseFailureGuidance,
  normalizeProductRoute,
  type JsonValue,
  type ProductRoute,
} from "@machine-memory/contract";
import type { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

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
  readonly expectedToken: Effect.Effect<Redacted.Redacted, Error, R>;
  readonly handleQuery: RestHandlerFn<R>;
  readonly handleMigration: RestHandlerFn<R>;
  readonly handleMigrationLinks: RestHandlerFn<R>;
  readonly handleVectorizeSearch: RestHandlerFn<R>;
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
  "/vectorize/search",
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

    const expectedToken = yield* handlers.expectedToken;
    if (
      request.headers.authorization !==
      `Bearer ${Redacted.value(expectedToken)}`
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
    return yield* route(bodyResult.body);
  }).pipe((effect) => catchInternal(effect, request.url));
}

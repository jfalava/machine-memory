import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { JsonValue } from "./json";

const INVALID_JSON_BODY_ERROR = "Invalid JSON request body.";
const INTERNAL_ERROR = "Internal server error.";

export type RestHandlerFn = (
  body: JsonValue,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, RuntimeContext>;

export type RestHandlers = {
  readonly expectedToken: Redacted.Redacted;
  readonly handleQuery: RestHandlerFn;
  readonly handleMigration: RestHandlerFn;
  readonly handleMigrationLinks: RestHandlerFn;
  readonly handleVectorizeUpsert: RestHandlerFn;
  readonly handleVectorizeSearch: RestHandlerFn;
  readonly handleVectorizeDelete: RestHandlerFn;
  readonly handleProduct: (
    route: string,
    body: JsonValue,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    RuntimeContext
  >;
};

function catchInternal(
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    RuntimeContext
  >,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, RuntimeContext> {
  return effect.pipe(
    Effect.catchCause(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { ok: false, error: INTERNAL_ERROR },
          { status: 500 },
        ),
      ),
    ),
  );
}

const PRODUCT_ROUTES = new Set([
  "/product/query",
  "/product/get",
  "/product/list",
  "/product/suggest",
  "/product/add",
  "/product/update",
  "/product/delete",
  "/product/verify",
  "/product/diff",
  "/product/size",
  "/product/list-repositories",
  "/product/list_repositories",
]);

const KNOWN_ROUTES = new Set([
  "/query",
  "/migrate",
  "/migrate/links",
  "/vectorize/upsert",
  "/vectorize/search",
  "/vectorize/delete",
  ...PRODUCT_ROUTES,
]);

export function handleRestRequest(
  handlers: RestHandlers,
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, RuntimeContext> {
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
    if (PRODUCT_ROUTES.has(request.url)) {
      return handlers.handleProduct(request.url, body);
    }
    return handlers.handleVectorizeSearch(body);
  };

  const guardedRoute = (body: JsonValue) => catchInternal(route(body));

  return Effect.gen(function* () {
    if (request.method !== "POST" || !KNOWN_ROUTES.has(request.url)) {
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

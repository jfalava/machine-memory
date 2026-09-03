import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { JsonValue } from "./json";

const INVALID_JSON_BODY_ERROR = "Invalid JSON request body.";
const INTERNAL_ERROR = "Internal server error.";

export type RestHandlers = {
  readonly expectedToken: Redacted.Redacted;
  readonly handleQuery: (
    body: JsonValue,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    RuntimeContext
  >;
  readonly handleMigration: (
    body: JsonValue,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    RuntimeContext
  >;
  readonly handleMigrationLinks: (
    body: JsonValue,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    RuntimeContext
  >;
  readonly handleVectorizeUpsert: (
    body: JsonValue,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    RuntimeContext
  >;
  readonly handleVectorizeSearch: (
    body: JsonValue,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    RuntimeContext
  >;
  readonly handleVectorizeDelete: (
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
    return handlers.handleVectorizeSearch(body);
  };

  const guardedRoute = (body: JsonValue) => catchInternal(route(body));

  return Effect.gen(function* () {
    if (
      request.method !== "POST" ||
      ![
        "/query",
        "/migrate",
        "/migrate/links",
        "/vectorize/upsert",
        "/vectorize/search",
        "/vectorize/delete",
      ].includes(request.url)
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

import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Database } from "./database";

type QueryOperation = "run" | "get" | "all";

type QueryRequest = {
  readonly operation: QueryOperation;
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
};

function parseQueryRequest(value: unknown): QueryRequest {
  if (!value || typeof value !== "object") {
    throw new Error("The request body must be a JSON object.");
  }
  const candidate = value as Record<string, unknown>;
  const operation = candidate.operation;
  if (operation !== "run" && operation !== "get" && operation !== "all") {
    throw new Error("The request operation must be run, get, or all.");
  }
  if (typeof candidate.sql !== "string" || candidate.sql.length === 0) {
    throw new Error("The request must contain a SQL statement.");
  }
  if (
    !Array.isArray(candidate.params) ||
    candidate.params.some(
      (param) => param !== null && typeof param !== "string" && typeof param !== "number",
    )
  ) {
    throw new Error("The request params must be SQLite JSON values.");
  }
  return {
    operation,
    sql: candidate.sql,
    params: candidate.params,
  };
}

export default class Api extends Cloudflare.Worker<Api>()(
  "machine-memory-api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const d1 = yield* Cloudflare.D1.QueryDatabase(Database);
    const sql = yield* SQL.D1(d1);
    const expectedToken = yield* Config.redacted("MACHINE_MEMORY_DB_TOKEN").pipe(Effect.orDie);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.method !== "POST" || request.url !== "/query") {
          return yield* HttpServerResponse.json({ error: "Not found" }, { status: 404 });
        }

        if (request.headers.authorization !== `Bearer ${Redacted.value(expectedToken)}`) {
          return yield* HttpServerResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = yield* request.json;
        const input = yield* Effect.try({
          try: () => ({ ok: true as const, value: parseQueryRequest(body) }),
          catch: (cause) => cause,
        }).pipe(
          Effect.catchCause(() =>
            Effect.succeed({
              ok: false as const,
              cause: "Invalid query request.",
            }),
          ),
        );
        if (!input.ok) {
          const cause = input.cause;
          return yield* HttpServerResponse.json(
            {
              ok: false,
              error: typeof cause === "string" ? cause : String(cause),
            },
            { status: 400 },
          );
        }

        if (input.value.operation === "run") {
          const response = yield* d1
            .prepare(input.value.sql)
            .bind(...input.value.params)
            .run();
          return yield* HttpServerResponse.json({
            ok: true,
            result: {
              changes: response.meta.changes,
              lastInsertRowid: response.meta.last_row_id,
            },
          });
        }

        const rows = yield* sql.unsafe<Record<string, unknown>>(
          input.value.sql,
          input.value.params,
        );
        const result = input.value.operation === "all" ? rows : (rows[0] ?? null);
        return yield* HttpServerResponse.json({ ok: true, result });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}

import { Effect, Layer } from "effect";
import type { SqlQueryBinding } from "../db";
import { MemoryDatabase, type MemoryDatabaseApi } from "./database";
import { MemoryDatabaseError } from "./errors";

type RemoteQueryOperation = "run" | "get" | "all";

type RemoteQueryResponse = {
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};

function remoteError(
  operation: RemoteQueryOperation,
  cause: unknown,
): MemoryDatabaseError {
  return new MemoryDatabaseError({
    operation,
    message: cause instanceof Error ? cause.message : "Remote query failed.",
    cause,
  });
}

function query(
  url: string,
  token: string | undefined,
  operation: RemoteQueryOperation,
  sql: string,
  params: SqlQueryBinding[],
): Effect.Effect<unknown, MemoryDatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (token) {
        headers.authorization = `Bearer ${token}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ operation, sql, params }),
      });
      const body = (await response.json()) as RemoteQueryResponse;
      if (!response.ok || body.ok !== true) {
        const message =
          typeof body.error === "string"
            ? body.error
            : `Remote database returned HTTP ${response.status}.`;
        throw new Error(message);
      }
      return body.result;
    },
    catch: (cause) => remoteError(operation, cause),
  });
}

function remoteApi(url: string, token: string | undefined): MemoryDatabaseApi {
  return {
    run: (sql, params = []) => query(url, token, "run", sql, params),
    get: (sql, params = []) => query(url, token, "get", sql, params),
    all: (sql, params = []) =>
      query(url, token, "all", sql, params).pipe(
        Effect.flatMap((result) =>
          Array.isArray(result)
            ? Effect.succeed(result)
            : Effect.fail(
                remoteError(
                  "all",
                  new Error("Remote database returned a non-array result."),
                ),
              ),
        ),
      ),
  };
}

export const remoteLayer = (
  url: string,
  token: string | undefined,
): Layer.Layer<MemoryDatabase, never> =>
  Layer.succeed(MemoryDatabase, remoteApi(url, token));

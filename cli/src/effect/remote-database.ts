import { decodeResponse, QuerySuccessSchema } from "@machine-memory/contract";
import { Effect, Layer } from "effect";

import type { SqlQueryBinding } from "../db";
import type { JsonValue } from "../json";
import { repositoryForCurrentDirectory } from "../repository";
import { MemoryDatabase, type MemoryDatabaseApi } from "./database";
import { MemoryDatabaseError } from "./errors";
import { postJson, toContractValue } from "./remote-http";
import { remoteVectorApi } from "./vectorize";

type RemoteQueryOperation = "run" | "get" | "all";

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
): Effect.Effect<JsonValue, MemoryDatabaseError> {
  return postJson({
    url,
    token,
    body: {
      operation,
      sql,
      params,
      repository: repositoryForCurrentDirectory(),
    },
    operation,
    service: "Remote database",
    fallbackMessage: "Remote query failed.",
    errorLabel: "remote/query",
    parse: (payload) => {
      const success = decodeResponse(
        QuerySuccessSchema,
        toContractValue(payload),
        "remote/query",
      );
      if (success === undefined) {
        throw new Error("Remote database returned an invalid response.");
      }
      // SAFETY: contract Json result re-enters the CLI as an opaque JSON value.
      return success.result as JsonValue;
    },
  });
}

function remoteApi(url: string, token: string | undefined): MemoryDatabaseApi {
  return {
    run: (sql, params = []) => query(url, token, "run", sql, params),
    get: (sql, params = []) => query(url, token, "get", sql, params),
    all: (sql, params = []) =>
      query(url, token, "all", sql, params).pipe(
        Effect.filterOrFail(
          (result): result is JsonValue[] => Array.isArray(result),
          () =>
            remoteError(
              "all",
              new Error("Remote database returned a non-array result."),
            ),
        ),
      ),
    vectorize: remoteVectorApi(url, token),
  };
}

export const remoteLayer = (
  url: string,
  token: string | undefined,
): Layer.Layer<MemoryDatabase, never> =>
  Layer.succeed(MemoryDatabase, remoteApi(url, token));

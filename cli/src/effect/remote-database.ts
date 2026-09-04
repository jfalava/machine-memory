import {
  decodeResponse,
  ErrorBodySchema,
  QuerySuccessSchema,
  type JsonValue as ContractJsonValue,
} from "@machine-memory/contract";
import { Effect, Layer } from "effect";
import type { SqlQueryBinding } from "../db";
import {
  jsonObject,
  jsonString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "../json";
import { MemoryDatabase, type MemoryDatabaseApi } from "./database";
import { MemoryDatabaseError } from "./errors";
import { remoteVectorApi } from "./vectorize";
import { repositoryForCurrentDirectory } from "../repository";

type RemoteQueryOperation = "run" | "get" | "all";

type RemoteQueryResponse = JsonObject;

type RequestHeaders = {
  "content-type": string;
  authorization?: string;
};

async function readRemoteResponse(
  response: Response,
): Promise<RemoteQueryResponse> {
  const text = await response.text();
  try {
    const parsed = jsonObject(parseJson(text));
    if (parsed === undefined) {
      throw new Error("response was not a JSON object");
    }
    return parsed;
  } catch (cause) {
    const contentType = response.headers.get("content-type") ?? "unknown";
    throw new Error(
      `Remote database returned non-JSON HTTP ${response.status} (${contentType}).`,
      { cause },
    );
  }
}

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
  return Effect.tryPromise({
    try: async () => {
      const headers: RequestHeaders = { "content-type": "application/json" };
      if (token) {
        headers.authorization = `Bearer ${token}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          operation,
          sql,
          params,
          repository: repositoryForCurrentDirectory(),
        }),
      });
      const body = await readRemoteResponse(response);
      // SAFETY: parsed JSON response bodies carry no undefined values.
      const contractBody = body as ContractJsonValue;
      if (!response.ok || body.ok !== true) {
        const failure = decodeResponse(
          ErrorBodySchema,
          contractBody,
          "remote/query",
        );
        const message =
          failure?.error ??
          jsonString(body.error) ??
          `Remote database returned HTTP ${response.status}.`;
        throw new Error(message);
      }
      const success = decodeResponse(
        QuerySuccessSchema,
        contractBody,
        "remote/query",
      );
      if (success === undefined) {
        throw new Error("Remote database returned an invalid response.");
      }
      // SAFETY: contract Json result re-enters the CLI as an opaque JSON value.
      return success.result as JsonValue;
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
    vectorize: remoteVectorApi(url, token),
  };
}

export const remoteLayer = (
  url: string,
  token: string | undefined,
): Layer.Layer<MemoryDatabase, never> =>
  Layer.succeed(MemoryDatabase, remoteApi(url, token));

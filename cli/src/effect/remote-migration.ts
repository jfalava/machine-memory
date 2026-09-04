import {
  decodeResponse,
  ErrorBodySchema,
  MigrationBatchResultSchema,
  MigrationLinksSuccessSchema,
  type JsonValue as ContractJsonValue,
} from "@machine-memory/contract";
import { Effect } from "effect";
import {
  jsonObject,
  jsonString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "../json";
import type {
  RemoteMigrationLink,
  RemoteMigrationRow,
} from "../remote-migration";
import { MemoryDatabaseError } from "./errors";

export type RemoteMigrationItem = {
  readonly source_id: number;
  readonly target_id: number;
  readonly status: "inserted" | "duplicate";
};

export type RemoteMigrationBatchResult = {
  readonly processed: number;
  readonly inserted: number;
  readonly duplicates: number;
  readonly items: RemoteMigrationItem[];
};

type RemoteMigrationResponse = JsonObject;

type RequestHeaders = {
  "content-type": string;
  authorization?: string;
};

function migrationError(operation: string, cause: unknown) {
  return new MemoryDatabaseError({
    operation,
    message:
      cause instanceof Error ? cause.message : "Remote migration failed.",
    cause,
  });
}

async function readResponse(
  response: Response,
  operation: string,
): Promise<RemoteMigrationResponse> {
  const text = await response.text();
  let parsed: JsonValue;
  try {
    parsed = parseJson(text);
  } catch (cause) {
    throw new Error(
      `Remote migration returned non-JSON HTTP ${response.status}.`,
      { cause },
    );
  }
  const responseBody = jsonObject(parsed);
  if (responseBody === undefined) {
    throw new Error(
      `Remote migration returned an invalid ${operation} response.`,
    );
  }
  return responseBody;
}

function migrationUrl(queryUrl: string, path: string): string {
  const parsed = new URL(queryUrl);
  const basePath = parsed.pathname.replace(/\/query\/?$/, "");
  parsed.pathname = `${basePath}${path}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function toContractValue(value: JsonValue): ContractJsonValue {
  // SAFETY: parsed JSON response values carry no undefined entries.
  return value as ContractJsonValue;
}

function parseBatchResult(value: JsonValue): RemoteMigrationBatchResult {
  const decoded = decodeResponse(
    MigrationBatchResultSchema,
    toContractValue(value),
    "remote/migrate",
  );
  if (decoded === undefined) {
    throw new Error("Remote migration returned an invalid batch result.");
  }
  return {
    processed: decoded.processed,
    inserted: decoded.inserted,
    duplicates: decoded.duplicates,
    items: decoded.items.map((item) => ({
      source_id: item.source_id,
      target_id: item.target_id,
      status: item.status,
    })),
  };
}

function request(
  queryUrl: string,
  token: string | undefined,
  path: string,
  body: JsonValue,
  operation: string,
): Effect.Effect<RemoteMigrationResponse, MemoryDatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      const headers: RequestHeaders = { "content-type": "application/json" };
      if (token) {
        headers.authorization = `Bearer ${token}`;
      }
      const response = await fetch(migrationUrl(queryUrl, path), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const parsed = await readResponse(response, operation);
      if (!response.ok || parsed.ok !== true) {
        const failure = decodeResponse(
          ErrorBodySchema,
          toContractValue(parsed),
          "remote/migrate",
        );
        const message =
          failure?.error ??
          jsonString(parsed.error) ??
          `Remote migration returned HTTP ${response.status}.`;
        throw new Error(message);
      }
      return parsed;
    },
    catch: (cause) => migrationError(operation, cause),
  });
}

export function migrateRemoteRows(
  queryUrl: string,
  token: string | undefined,
  repository: string,
  rows: RemoteMigrationRow[],
): Effect.Effect<RemoteMigrationBatchResult, MemoryDatabaseError> {
  return request(
    queryUrl,
    token,
    "/migrate",
    { repository, rows },
    "remote/migrate",
  ).pipe(
    Effect.flatMap((response) =>
      Effect.try({
        try: () => parseBatchResult(response.result),
        catch: (cause) => migrationError("remote/migrate", cause),
      }),
    ),
  );
}

export function migrateRemoteLinks(
  queryUrl: string,
  token: string | undefined,
  repository: string,
  links: RemoteMigrationLink[],
): Effect.Effect<void, MemoryDatabaseError> {
  return request(
    queryUrl,
    token,
    "/migrate/links",
    { repository, links },
    "remote/migrate-links",
  ).pipe(
    Effect.flatMap((response) =>
      Effect.try({
        try: () => {
          const decoded = decodeResponse(
            MigrationLinksSuccessSchema,
            toContractValue(response),
            "remote/migrate-links",
          );
          if (decoded === undefined) {
            throw new Error(
              "Remote migration returned an invalid links result.",
            );
          }
        },
        catch: (cause) => migrationError("remote/migrate-links", cause),
      }),
    ),
  );
}

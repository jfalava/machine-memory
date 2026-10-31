import {
  decodeResponse,
  MigrationBatchResultSchema,
  MigrationLinksSuccessSchema,
} from "@machine-memory/contract";
import type { Effect } from "effect";

import type { JsonObject, JsonValue } from "../json";
import type {
  RemoteMigrationLink,
  RemoteMigrationRow,
} from "../remote-migration";
import type { MemoryDatabaseError } from "./errors";
import { apiUrl, postJson, toContractValue } from "./remote-http";

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

function migrationRequest<T>(options: {
  readonly queryUrl: string;
  readonly token: string | undefined;
  readonly path: string;
  readonly body: JsonValue;
  readonly operation: string;
  readonly parse: (payload: JsonObject) => T;
}): Effect.Effect<T, MemoryDatabaseError> {
  return postJson({
    url: apiUrl(options.queryUrl, options.path),
    token: options.token,
    body: options.body,
    operation: options.operation,
    service: "Remote migration",
    fallbackMessage: "Remote migration failed.",
    errorLabel: "remote/migrate",
    invalidObjectMessage: `Remote migration returned an invalid ${options.operation} response.`,
    parse: options.parse,
  });
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

export function migrateRemoteRows(
  queryUrl: string,
  token: string | undefined,
  repository: string,
  source: string,
  rows: RemoteMigrationRow[],
): Effect.Effect<RemoteMigrationBatchResult, MemoryDatabaseError> {
  return migrationRequest({
    queryUrl,
    token,
    path: "/migrate",
    body: { repository, source, rows },
    operation: "remote/migrate",
    parse: (payload) => parseBatchResult(payload.result),
  });
}

export function migrateRemoteLinks(
  queryUrl: string,
  token: string | undefined,
  repository: string,
  links: RemoteMigrationLink[],
): Effect.Effect<void, MemoryDatabaseError> {
  return migrationRequest({
    queryUrl,
    token,
    path: "/migrate/links",
    body: { repository, links },
    operation: "remote/migrate-links",
    parse: (payload) => {
      const decoded = decodeResponse(
        MigrationLinksSuccessSchema,
        toContractValue(payload),
        "remote/migrate-links",
      );
      if (decoded === undefined) {
        throw new Error("Remote migration returned an invalid links result.");
      }
    },
  });
}

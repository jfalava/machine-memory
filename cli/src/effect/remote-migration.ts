import { Effect } from "effect";
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

type RemoteMigrationResponse = {
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `Remote migration returned non-JSON HTTP ${response.status}.`,
      { cause },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Remote migration returned an invalid ${operation} response.`,
    );
  }
  return parsed as RemoteMigrationResponse;
}

function migrationUrl(queryUrl: string, path: string): string {
  const parsed = new URL(queryUrl);
  const basePath = parsed.pathname.replace(/\/query\/?$/, "");
  parsed.pathname = `${basePath}${path}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Remote migration returned an invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function integerField(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Remote migration returned an invalid ${label}.`);
  }
  return value;
}

function parseBatchResult(value: unknown): RemoteMigrationBatchResult {
  const result = asRecord(value, "batch result");
  const rawItems = result.items;
  if (!Array.isArray(rawItems)) {
    throw new Error("Remote migration returned invalid batch items.");
  }
  const items = rawItems.map((item, index): RemoteMigrationItem => {
    const record = asRecord(item, `batch item ${index + 1}`);
    const status = record.status;
    if (status !== "inserted" && status !== "duplicate") {
      throw new Error(`Remote migration returned an invalid item status.`);
    }
    return {
      source_id: integerField(record.source_id, "source_id"),
      target_id: integerField(record.target_id, "target_id"),
      status,
    };
  });
  return {
    processed: integerField(result.processed, "processed"),
    inserted: integerField(result.inserted, "inserted"),
    duplicates: integerField(result.duplicates, "duplicates"),
    items,
  };
}

function request(
  queryUrl: string,
  token: string | undefined,
  path: string,
  body: unknown,
  operation: string,
): Effect.Effect<RemoteMigrationResponse, MemoryDatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
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
        const message =
          typeof parsed.error === "string"
            ? parsed.error
            : `Remote migration returned HTTP ${response.status}.`;
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
  ).pipe(Effect.asVoid);
}

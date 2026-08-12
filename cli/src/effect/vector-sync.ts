import { Effect } from "effect";
import type { MemoryDatabaseApi } from "./database";
import { MemoryDatabaseError } from "./errors";
import type { MemoryVectorDocument } from "./vectorize";
import { jsonNumber, jsonString, type JsonObject } from "../json";

function stringField(row: JsonObject, field: string, fallback = ""): string {
  return jsonString(row[field]) ?? fallback;
}

export function memoryVectorDocument(row: JsonObject): MemoryVectorDocument {
  const id = row.id;
  const stringId = jsonString(id);
  const numberId = jsonNumber(id);
  if (stringId === undefined && numberId === undefined) {
    throw new Error("Memory rows require an id before vector synchronization.");
  }
  const repository = stringField(row, "repository");
  const content = stringField(row, "content");
  if (!repository || !content) {
    throw new Error(
      "Memory rows require repository and content before vector synchronization.",
    );
  }
  return {
    id: stringId ?? String(numberId),
    repository,
    content,
    tags: stringField(row, "tags"),
    context: stringField(row, "context"),
    memory_type: stringField(row, "memory_type", "convention"),
    status: stringField(row, "status", "active"),
    certainty: stringField(row, "certainty", "inferred"),
  };
}

export function upsertMemoryVector(
  database: MemoryDatabaseApi,
  row: JsonObject,
): Effect.Effect<void, MemoryDatabaseError> {
  const vectorize = database.vectorize;
  if (!vectorize) {
    return Effect.void;
  }
  return Effect.try({
    try: () => memoryVectorDocument(row),
    catch: (cause) =>
      new MemoryDatabaseError({
        operation: "vectorize/upsert",
        message:
          cause instanceof Error
            ? cause.message
            : "Could not prepare a memory vector.",
        cause,
      }),
  }).pipe(
    Effect.flatMap((document) => vectorize.upsert(document)),
    Effect.asVoid,
  );
}

export function syncMemoryVector(
  database: MemoryDatabaseApi,
  row: JsonObject,
): Effect.Effect<void, never> {
  return upsertMemoryVector(database, row).pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        console.error(
          `Warning: memory ${jsonString(row.id) ?? jsonNumber(row.id)?.toString() ?? "unknown"} was saved but vector synchronization failed: ${error.message}`,
        ),
      ),
    ),
    Effect.catchCause(() => Effect.void),
  );
}

export function deleteMemoryVector(
  database: MemoryDatabaseApi,
  id: number,
): Effect.Effect<void, never> {
  const vectorize = database.vectorize;
  if (!vectorize) {
    return Effect.void;
  }
  return vectorize.delete(String(id)).pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        console.error(
          `Warning: memory ${id} was deleted but vector cleanup failed: ${error.message}`,
        ),
      ),
    ),
    Effect.asVoid,
    Effect.catchCause(() => Effect.void),
  );
}

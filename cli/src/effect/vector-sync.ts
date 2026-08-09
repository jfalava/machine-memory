import { Effect } from "effect";
import type { MemoryDatabaseApi } from "./database";
import { MemoryDatabaseError } from "./errors";
import type { MemoryVectorDocument } from "./vectorize";

function stringField(
  row: Record<string, unknown>,
  field: string,
  fallback = "",
): string {
  return typeof row[field] === "string" ? row[field] : fallback;
}

export function memoryVectorDocument(
  row: Record<string, unknown>,
): MemoryVectorDocument {
  const id = row.id;
  if (typeof id !== "string" && typeof id !== "number") {
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
    id: String(id),
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
  row: Record<string, unknown>,
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
  row: Record<string, unknown>,
): Effect.Effect<void, never> {
  return upsertMemoryVector(database, row).pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        console.error(
          `Warning: memory ${String(row.id)} was saved but vector synchronization failed: ${error.message}`,
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

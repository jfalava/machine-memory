import {
  composeEmbeddingText,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  StoredMemoryRowSchema,
  normalizeStoredMemoryRow,
  validateEmbeddingText,
  VECTOR_SYNC_NEVER,
  type JsonValue,
} from "@machine-memory/contract";
import { Schema } from "effect";

// Each delivery is re-sent once, an hour later, to overwrite a mutation that
// Vectorize applied late. Repeating it forever re-embeds unchanged memories;
// index drift beyond that window is repaired with `reindex`.
const REPAIR_INTERVAL_MS = 60 * 60 * 1000;
const REPAIRED = VECTOR_SYNC_NEVER;
const BATCH_SIZE = 20;

type PendingVector = {
  memory_id: number;
  generation: number;
  delivered_generation: number;
  attempts: number;
};

export type VectorSyncResources = {
  db: D1Database;
  index: {
    upsert: (vectors: VectorizeVector[]) => Promise<{ mutationId: string }>;
    deleteByIds: (ids: string[]) => Promise<{ mutationId: string }>;
  };
  embed: (text: string) => Promise<number[]>;
};

export function parseEmbedding(output: JsonValue): number[] {
  const decoded = Schema.decodeUnknownSync(
    Schema.Struct({
      data: Schema.Array(Schema.Array(Schema.Number.check(Schema.isFinite()))),
    }),
  )(output);
  if (
    decoded.data.length !== 1 ||
    decoded.data[0].length !== EMBEDDING_DIMENSIONS
  ) {
    throw new Error(
      `Workers AI must return one ${EMBEDDING_DIMENSIONS}-dimensional embedding.`,
    );
  }
  return [...decoded.data[0]];
}

export function aiEmbedding(ai: Ai, text: string): Promise<number[]> {
  validateEmbeddingText(text, "Embedding text");
  return ai
    .run(EMBEDDING_MODEL, { text: [text] })
    .then((output) =>
      parseEmbedding(Schema.decodeUnknownSync(Schema.Json)(output)),
    );
}

/** The stored row cannot be embedded as it is, so retrying cannot help. */
class UnembeddableMemoryError extends Error {}

async function currentVector(
  db: D1Database,
  id: number,
  embed: VectorSyncResources["embed"],
): Promise<VectorizeVector | undefined> {
  const stored = await db
    .prepare("SELECT * FROM memories WHERE id = ?")
    .bind(id)
    .first();
  if (stored === null) {
    return undefined;
  }
  let row: ReturnType<typeof normalizeStoredMemoryRow>;
  let text: string;
  try {
    row = normalizeStoredMemoryRow(
      Schema.decodeUnknownSync(StoredMemoryRowSchema)(stored),
    );
    text = validateEmbeddingText(composeEmbeddingText(row), "Memory");
  } catch (cause) {
    throw new UnembeddableMemoryError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  // Inactive rows need deletion, not a longer status-bearing embedding.
  if (row.status !== "active") {
    return undefined;
  }
  const values = await embed(text);
  if (
    values.length !== EMBEDDING_DIMENSIONS ||
    values.some((v) => !Number.isFinite(v))
  ) {
    throw new Error("Invalid embedding values.");
  }
  return {
    id: String(row.id),
    namespace: row.repository,
    values,
    metadata: {
      status: row.status,
      memory_type: row.memory_type,
      certainty: row.certainty,
    },
  };
}

/**
 * Records a failed delivery. A row that cannot be embedded is parked until the
 * memory changes or reindex re-queues it; any other failure, such as an
 * unreachable Workers AI or Vectorize, is retried with backoff so an outage
 * heals on its own.
 */
async function recordFailure(
  db: D1Database,
  job: PendingVector,
  failure: { parked: boolean; message: string },
  now: number,
): Promise<void> {
  const delay = Math.min(300_000, 1000 * 2 ** Math.min(job.attempts, 8));
  await db
    .prepare(`UPDATE memory_vector_sync SET attempts = attempts + 1,
    next_attempt_at = ?, last_error = ? WHERE memory_id = ? AND generation = ?`)
    .bind(
      failure.parked ? VECTOR_SYNC_NEVER : now + delay,
      failure.message.slice(0, 500),
      job.memory_id,
      job.generation,
    )
    .run();
  console.error(
    JSON.stringify({
      event: failure.parked ? "vector_sync_parked" : "vector_sync_retry",
      id: job.memory_id,
      error: failure.message,
    }),
  );
}

/** Called only by the coordinator's alarm: there is one mutation-producing drain. */
export async function drainVectorSync(
  { db, index, embed }: VectorSyncResources,
  now = Date.now(),
): Promise<void> {
  const jobs = await db
    .prepare(`SELECT memory_id, generation, delivered_generation, attempts FROM memory_vector_sync
    WHERE next_attempt_at <= ? AND (generation > delivered_generation OR last_delivered_at <= ?)
    ORDER BY next_attempt_at, memory_id LIMIT ?`)
    .bind(now, now - REPAIR_INTERVAL_MS, BATCH_SIZE)
    .all<PendingVector>();
  for (const job of jobs.results) {
    try {
      const vector = await currentVector(db, job.memory_id, embed);
      const current = await db
        .prepare(
          "SELECT generation FROM memory_vector_sync WHERE memory_id = ?",
        )
        .bind(job.memory_id)
        .first<{ generation: number }>();
      if (current?.generation !== job.generation) {
        continue;
      }
      if (vector === undefined) {
        await index.deleteByIds([String(job.memory_id)]);
      } else {
        await index.upsert([vector]);
      }
      // A mutation during the remote call stays pending; retry never rewrites canonical data.
      await db
        .prepare(`UPDATE memory_vector_sync SET delivered_generation = ?, attempts = 0,
        last_error = NULL, last_delivered_at = ?, next_attempt_at = ?
        WHERE memory_id = ? AND generation = ?`)
        .bind(
          job.generation,
          now,
          // Write triggers and reindex reset next_attempt_at to 0.
          job.delivered_generation === job.generation
            ? REPAIRED
            : now + REPAIR_INTERVAL_MS,
          job.memory_id,
          job.generation,
        )
        .run();
    } catch (error) {
      await recordFailure(
        db,
        job,
        {
          parked: error instanceof UnembeddableMemoryError,
          message: error instanceof Error ? error.message : String(error),
        },
        now,
      );
    }
  }
}

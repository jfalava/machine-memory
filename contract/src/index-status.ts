import { Schema } from "effect";

import type { JsonValue } from "./json";

/**
 * `next_attempt_at` of a `memory_vector_sync` row the drain will not pick up
 * again. With an undelivered generation the row is parked: retrying cannot fix
 * it until the memory changes or `reindex` re-queues it.
 */
export const VECTOR_SYNC_NEVER = Number.MAX_SAFE_INTEGER;

const FAILURE_GROUP_LIMIT = 20;
const FAILURE_ID_LIMIT = 20;

export const IndexStatusSchema = Schema.Struct({
  /** Memories whose latest write has not reached the index and has not failed. */
  pending: Schema.Finite,
  /** Memories whose last index write failed and will be tried again. */
  retrying: Schema.Finite,
  /** Memories whose index write failed in a way retrying cannot fix. */
  parked: Schema.Finite,
  /** Seconds the oldest pending or retrying memory has waited; null when unknown. */
  oldest_pending_seconds: Schema.NullOr(Schema.Finite),
  /** Failed memories grouped by error, largest group first. */
  failures: Schema.Array(
    Schema.Struct({
      error: Schema.String,
      state: Schema.Literals(["retrying", "parked"]),
      count: Schema.Finite,
      /** Up to 20 memory ids from the group, for `reindex --id`. */
      ids: Schema.Array(Schema.Finite),
    }),
  ),
});
export type IndexStatus = typeof IndexStatusSchema.Type;

/**
 * The two queries behind an index status: one row of counts, then the failure
 * groups. `repository` undefined covers every repository.
 */
export function indexStatusQueries(repository: string | undefined) {
  const scope = repository === undefined ? "" : " AND repository = ?";
  const scopeParams = repository === undefined ? [] : [repository];
  return {
    counts: {
      sql: `SELECT
        COALESCE(SUM(last_error IS NULL), 0) AS pending,
        COALESCE(SUM(last_error IS NOT NULL AND next_attempt_at < ?), 0) AS retrying,
        COALESCE(SUM(last_error IS NOT NULL AND next_attempt_at >= ?), 0) AS parked,
        MIN(CASE WHEN next_attempt_at < ? AND queued_at > 0 THEN queued_at END) AS oldest_queued_at
        FROM memory_vector_sync WHERE generation > delivered_generation${scope}`,
      params: [
        VECTOR_SYNC_NEVER,
        VECTOR_SYNC_NEVER,
        VECTOR_SYNC_NEVER,
        ...scopeParams,
      ],
    },
    failures: {
      sql: `SELECT last_error AS error, next_attempt_at >= ? AS parked,
        COUNT(*) AS count, group_concat(memory_id) AS ids
        FROM memory_vector_sync
        WHERE generation > delivered_generation AND last_error IS NOT NULL${scope}
        GROUP BY last_error, parked ORDER BY count DESC, error LIMIT ${FAILURE_GROUP_LIMIT}`,
      params: [VECTOR_SYNC_NEVER, ...scopeParams],
    },
  };
}

const CountsRowSchema = Schema.Struct({
  pending: Schema.Finite,
  retrying: Schema.Finite,
  parked: Schema.Finite,
  oldest_queued_at: Schema.NullOr(Schema.Finite),
});
const FailureRowSchema = Schema.Struct({
  error: Schema.String,
  parked: Schema.Finite,
  count: Schema.Finite,
  ids: Schema.String,
});

/** Shapes the rows of `indexStatusQueries` into the reported status. */
export function indexStatusFromRows(
  countsRow: JsonValue,
  failureRows: readonly JsonValue[],
  now = Date.now(),
): IndexStatus {
  const counts = Schema.decodeUnknownSync(CountsRowSchema)(countsRow);
  return {
    pending: counts.pending,
    retrying: counts.retrying,
    parked: counts.parked,
    oldest_pending_seconds:
      counts.oldest_queued_at === null
        ? null
        : Math.max(0, Math.round((now - counts.oldest_queued_at) / 1000)),
    failures: failureRows.map((raw) => {
      const row = Schema.decodeUnknownSync(FailureRowSchema)(raw);
      return {
        error: row.error,
        state: row.parked === 1 ? ("parked" as const) : ("retrying" as const),
        count: row.count,
        ids: row.ids.split(",").slice(0, FAILURE_ID_LIMIT).map(Number),
      };
    }),
  };
}

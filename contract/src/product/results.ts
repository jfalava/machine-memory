import { Schema } from "effect";

import { okResponseSchema } from "../api/responses";
import { EmbeddingSizeReportSchema } from "../embedding";
import {
  MemoryRowSchema,
  MemorySummarySchema,
  MemoryTypeSchema,
  MemoryStatusSchema,
} from "../entities";
import { DroppedDetailsSchema } from "../reconcile";
import { MatchStrengthSchema } from "../search";

export const FactCheckResultSchema = Schema.Struct({
  similarity: Schema.Finite,
  conflict: Schema.Boolean,
  added_terms: Schema.Array(Schema.String),
  removed_terms: Schema.Array(Schema.String),
});
export type FactCheckResult = typeof FactCheckResultSchema.Type;

export const ScoredMemoryRowSchema = Schema.Struct({
  ...MemorySummarySchema.fields,
  score: Schema.Finite,
  match_strength: MatchStrengthSchema,
  term_coverage: Schema.Finite,
  exact_matches: Schema.Array(Schema.String),
});
export type ScoredMemoryRow = typeof ScoredMemoryRowSchema.Type;

export const UpsertMatchInfoSchema = Schema.Struct({
  id: Schema.Finite,
  score: Schema.Finite,
  similarity: Schema.Finite,
  memory_type: MemoryTypeSchema,
  status: MemoryStatusSchema,
  content_head: Schema.String,
});
export type UpsertMatchInfo = typeof UpsertMatchInfoSchema.Type;

/** Echo of an update-by-match resolution (query that resolved + hit id/score). */
export const MatchedUpdateTargetSchema = Schema.Struct({
  query: Schema.String,
  id: Schema.Finite,
  score: Schema.Finite,
});
export type MatchedUpdateTarget = typeof MatchedUpdateTargetSchema.Type;

export const MemoryWriteResultSchema = Schema.Struct({
  mode: Schema.optionalKey(Schema.String),
  written_to: Schema.String,
  id: Schema.Finite,
  memory: MemoryRowSchema,
  size: Schema.optionalKey(EmbeddingSizeReportSchema),
  upsert_match: Schema.optionalKey(UpsertMatchInfoSchema),
  matched: Schema.optionalKey(MatchedUpdateTargetSchema),
  potential_conflicts: Schema.optionalKey(Schema.Array(ScoredMemoryRowSchema)),
  /** Paths, identifiers, and sentences the new content no longer carries. */
  dropped: Schema.optionalKey(DroppedDetailsSchema),
  /** Other active records that may rely on the changed premise. */
  review_candidates: Schema.optionalKey(Schema.Array(ScoredMemoryRowSchema)),
});
export type MemoryWriteResult = typeof MemoryWriteResultSchema.Type;

export const RepositoryStatsSchema = Schema.Struct({
  slug: Schema.String,
  total: Schema.Finite,
  active: Schema.Finite,
  deprecated: Schema.Finite,
  superseded: Schema.Finite,
});

export const ListRepositoriesResultSchema = Schema.Struct({
  repositories: Schema.Array(RepositoryStatsSchema),
  count: Schema.Finite,
  total_count: Schema.Finite,
  offset: Schema.Finite,
  limit: Schema.Finite,
  has_more: Schema.Boolean,
});
export const ListRepositoriesSuccessSchema = okResponseSchema(
  ListRepositoriesResultSchema,
);

export const MemoryGetSuccessSchema = okResponseSchema(MemoryRowSchema);
export type MemoryGetSuccess = typeof MemoryGetSuccessSchema.Type;

export const MemoryHistoryEntrySchema = Schema.Struct({
  revision_id: Schema.Finite,
  operation: Schema.String,
  snapshot_at: Schema.String,
  ...MemoryRowSchema.fields,
});
export type MemoryHistoryEntry = typeof MemoryHistoryEntrySchema.Type;

export const MemoryHistoryResultSchema = Schema.Struct({
  repository: Schema.String,
  id: Schema.Finite,
  current_update_count: Schema.NullOr(Schema.Int),
  count: Schema.Finite,
  total_count: Schema.Finite,
  offset: Schema.Finite,
  limit: Schema.Finite,
  has_more: Schema.Boolean,
  results: Schema.Array(MemoryHistoryEntrySchema),
});
export const MemoryHistorySuccessSchema = okResponseSchema(
  MemoryHistoryResultSchema,
);

export const MemoryListResultSchema = Schema.Struct({
  count: Schema.Finite,
  total_count: Schema.Finite,
  offset: Schema.Finite,
  limit: Schema.Finite,
  has_more: Schema.Boolean,
  results: Schema.Array(MemoryRowSchema),
});
export const MemoryListSuccessSchema = okResponseSchema(MemoryListResultSchema);

export const MemoryQueryResultSchema = Schema.Struct({
  count: Schema.Finite,
  no_strong_match: Schema.Boolean,
  results: Schema.Array(ScoredMemoryRowSchema),
});
export const MemoryQuerySuccessSchema = okResponseSchema(
  MemoryQueryResultSchema,
);

export const MemorySuggestResultSchema = Schema.Struct({
  files: Schema.Array(Schema.String),
  normalized_path_terms: Schema.Array(Schema.String),
  derived_terms: Schema.Array(Schema.String),
  neighborhood: Schema.Struct({
    tags: Schema.Array(Schema.String),
    paths: Schema.Array(Schema.String),
  }),
  count: Schema.Finite,
  no_strong_match: Schema.Boolean,
  results: Schema.Array(ScoredMemoryRowSchema),
});
export const MemorySuggestSuccessSchema = okResponseSchema(
  MemorySuggestResultSchema,
);

export const MemoryVerifyResultSchema = Schema.Struct({
  id: Schema.Finite,
  ok: Schema.Boolean,
  result: Schema.Literals(["consistent", "conflict"]),
  similarity: Schema.Finite,
  warning: Schema.optionalKey(Schema.String),
});
export const MemoryVerifySuccessSchema = okResponseSchema(
  MemoryVerifyResultSchema,
);

export const MemoryDiffResultSchema = Schema.Struct({
  id: Schema.Finite,
  conflict: Schema.Boolean,
  similarity: Schema.Finite,
  added_terms: Schema.Array(Schema.String),
  removed_terms: Schema.Array(Schema.String),
  dropped: DroppedDetailsSchema,
});
export const MemoryDiffSuccessSchema = okResponseSchema(MemoryDiffResultSchema);

export const MemorySizeResultSchema = Schema.Struct({
  size: EmbeddingSizeReportSchema,
});
export const MemorySizeSuccessSchema = okResponseSchema(MemorySizeResultSchema);

export const MemoryDeleteResultSchema = Schema.Struct({
  deleted_from: Schema.String,
  id: Schema.Finite,
  deleted: Schema.Boolean,
  existed: Schema.Boolean,
});
export const MemoryDeleteSuccessSchema = okResponseSchema(
  MemoryDeleteResultSchema,
);

export const MemoryDeleteManyResultSchema = Schema.Struct({
  deleted_from: Schema.String,
  requested_ids: Schema.Array(Schema.Finite),
  deleted_ids: Schema.Array(Schema.Finite),
  not_found: Schema.Array(Schema.Finite),
  count: Schema.Finite,
});
export const MemoryDeleteManySuccessSchema = okResponseSchema(
  MemoryDeleteManyResultSchema,
);

export const MemoryDeprecateResultSchema = Schema.Struct({
  written_to: Schema.String,
  status: MemoryStatusSchema,
  superseded_by: Schema.NullOr(Schema.Finite),
  requested_ids: Schema.Array(Schema.Finite),
  deprecated: Schema.Array(MemoryRowSchema),
  not_found: Schema.Array(Schema.Finite),
  count: Schema.Finite,
  /** Active records that may rely on a retired premise. */
  review_candidates: Schema.optionalKey(Schema.Array(ScoredMemoryRowSchema)),
});
export type MemoryDeprecateResult = typeof MemoryDeprecateResultSchema.Type;
export const MemoryDeprecateSuccessSchema = okResponseSchema(
  MemoryDeprecateResultSchema,
);
export type MemoryDeprecateSuccess = typeof MemoryDeprecateSuccessSchema.Type;

export const MemoryGcResultSchema = Schema.Struct({
  repository: Schema.String,
  dry_run: Schema.Literal(true),
  count: Schema.Finite,
  ids: Schema.Array(Schema.Finite),
  expired: Schema.Array(MemoryRowSchema),
});
export const MemoryGcSuccessSchema = okResponseSchema(MemoryGcResultSchema);

export const MemoryStatsResultSchema = Schema.Struct({
  repository: Schema.String,
  total_memories: Schema.Finite,
  active: Schema.Finite,
  deprecated: Schema.Finite,
  superseded: Schema.Finite,
  breakdown_by_memory_type: Schema.Record(Schema.String, Schema.Finite),
  breakdown_by_certainty: Schema.Record(Schema.String, Schema.Finite),
  tag_frequency_map: Schema.Record(Schema.String, Schema.Finite),
  oldest_memory: Schema.NullOr(
    Schema.Struct({
      id: Schema.Finite,
      created_at: Schema.NullOr(Schema.String),
    }),
  ),
  memories_not_updated_over_90_days: Schema.Finite,
  memories_with_no_tags: Schema.Finite,
});
export type MemoryStatsResult = typeof MemoryStatsResultSchema.Type;
export const MemoryStatsSuccessSchema = okResponseSchema(
  MemoryStatsResultSchema,
);
export type MemoryStatsSuccess = typeof MemoryStatsSuccessSchema.Type;

export const MemoryDoctorFindingSchema = Schema.Struct({
  kind: Schema.String,
  ids: Schema.Array(Schema.Finite),
  details: Schema.Record(Schema.String, Schema.Json),
});
export type MemoryDoctorFinding = typeof MemoryDoctorFindingSchema.Type;

export const MemoryDoctorResultSchema = Schema.Struct({
  repository: Schema.String,
  checked: Schema.Finite,
  count: Schema.Finite,
  findings: Schema.Array(MemoryDoctorFindingSchema),
  counts_by_kind: Schema.Record(Schema.String, Schema.Finite),
});
export type MemoryDoctorResult = typeof MemoryDoctorResultSchema.Type;
export const MemoryDoctorSuccessSchema = okResponseSchema(
  MemoryDoctorResultSchema,
);

export const MemoryWriteSuccessSchema = okResponseSchema(
  MemoryWriteResultSchema,
);

export const MemoryRestoreResultSchema = Schema.Struct({
  written_to: Schema.String,
  id: Schema.Finite,
  restored_revision_id: Schema.Finite,
  memory: MemoryRowSchema,
  size: EmbeddingSizeReportSchema,
});
export const MemoryRestoreSuccessSchema = okResponseSchema(
  MemoryRestoreResultSchema,
);

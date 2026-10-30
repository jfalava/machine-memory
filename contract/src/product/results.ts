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
  similarity: Schema.Number,
  conflict: Schema.Boolean,
  added_terms: Schema.Array(Schema.String),
  removed_terms: Schema.Array(Schema.String),
});
export type FactCheckResult = typeof FactCheckResultSchema.Type;

export const ScoredMemoryRowSchema = Schema.Struct({
  ...MemorySummarySchema.fields,
  score: Schema.Number,
  match_strength: MatchStrengthSchema,
  term_coverage: Schema.Number,
  exact_matches: Schema.Array(Schema.String),
});
export type ScoredMemoryRow = typeof ScoredMemoryRowSchema.Type;

export const UpsertMatchInfoSchema = Schema.Struct({
  id: Schema.Number,
  score: Schema.Number,
  similarity: Schema.Number,
  memory_type: MemoryTypeSchema,
  status: MemoryStatusSchema,
  content_head: Schema.String,
});
export type UpsertMatchInfo = typeof UpsertMatchInfoSchema.Type;

/** Echo of an update-by-match resolution (query that resolved + hit id/score). */
export const MatchedUpdateTargetSchema = Schema.Struct({
  query: Schema.String,
  id: Schema.Number,
  score: Schema.Number,
});
export type MatchedUpdateTarget = typeof MatchedUpdateTargetSchema.Type;

export const MemoryWriteResultSchema = Schema.Struct({
  mode: Schema.optionalKey(Schema.String),
  written_to: Schema.String,
  id: Schema.Number,
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
  total: Schema.Number,
  active: Schema.Number,
  deprecated: Schema.Number,
  superseded: Schema.Number,
});
export type RepositoryStats = typeof RepositoryStatsSchema.Type;

export const ListRepositoriesResultSchema = Schema.Struct({
  repositories: Schema.Array(RepositoryStatsSchema),
  count: Schema.Number,
  total_count: Schema.Number,
  offset: Schema.Number,
  limit: Schema.Number,
  has_more: Schema.Boolean,
});
export type ListRepositoriesResult = typeof ListRepositoriesResultSchema.Type;
export const ListRepositoriesSuccessSchema = okResponseSchema(
  ListRepositoriesResultSchema,
);
export type ListRepositoriesSuccess = typeof ListRepositoriesSuccessSchema.Type;

export const MemoryGetSuccessSchema = okResponseSchema(MemoryRowSchema);
export type MemoryGetSuccess = typeof MemoryGetSuccessSchema.Type;

export const MemoryHistoryEntrySchema = Schema.Struct({
  revision_id: Schema.Number,
  operation: Schema.String,
  snapshot_at: Schema.String,
  ...MemoryRowSchema.fields,
});
export type MemoryHistoryEntry = typeof MemoryHistoryEntrySchema.Type;

export const MemoryHistoryResultSchema = Schema.Struct({
  repository: Schema.String,
  id: Schema.Number,
  current_update_count: Schema.NullOr(Schema.Int),
  count: Schema.Number,
  total_count: Schema.Number,
  offset: Schema.Number,
  limit: Schema.Number,
  has_more: Schema.Boolean,
  results: Schema.Array(MemoryHistoryEntrySchema),
});
export type MemoryHistoryResult = typeof MemoryHistoryResultSchema.Type;
export const MemoryHistorySuccessSchema = okResponseSchema(
  MemoryHistoryResultSchema,
);
export type MemoryHistorySuccess = typeof MemoryHistorySuccessSchema.Type;

export const MemoryListResultSchema = Schema.Struct({
  count: Schema.Number,
  total_count: Schema.Number,
  offset: Schema.Number,
  limit: Schema.Number,
  has_more: Schema.Boolean,
  results: Schema.Array(MemoryRowSchema),
});
export type MemoryListResult = typeof MemoryListResultSchema.Type;
export const MemoryListSuccessSchema = okResponseSchema(MemoryListResultSchema);
export type MemoryListSuccess = typeof MemoryListSuccessSchema.Type;

export const MemoryQueryResultSchema = Schema.Struct({
  count: Schema.Number,
  no_strong_match: Schema.Boolean,
  results: Schema.Array(ScoredMemoryRowSchema),
});
export type MemoryQueryResult = typeof MemoryQueryResultSchema.Type;
export const MemoryQuerySuccessSchema = okResponseSchema(
  MemoryQueryResultSchema,
);
export type MemoryQuerySuccess = typeof MemoryQuerySuccessSchema.Type;

export const MemorySuggestResultSchema = Schema.Struct({
  files: Schema.Array(Schema.String),
  normalized_path_terms: Schema.Array(Schema.String),
  derived_terms: Schema.Array(Schema.String),
  neighborhood: Schema.Struct({
    tags: Schema.Array(Schema.String),
    paths: Schema.Array(Schema.String),
  }),
  count: Schema.Number,
  no_strong_match: Schema.Boolean,
  results: Schema.Array(ScoredMemoryRowSchema),
});
export type MemorySuggestResult = typeof MemorySuggestResultSchema.Type;
export const MemorySuggestSuccessSchema = okResponseSchema(
  MemorySuggestResultSchema,
);
export type MemorySuggestSuccess = typeof MemorySuggestSuccessSchema.Type;

export const MemoryVerifyResultSchema = Schema.Struct({
  id: Schema.Number,
  ok: Schema.Boolean,
  result: Schema.Literals(["consistent", "conflict"]),
  similarity: Schema.Number,
  warning: Schema.optionalKey(Schema.String),
});
export type MemoryVerifyResult = typeof MemoryVerifyResultSchema.Type;
export const MemoryVerifySuccessSchema = okResponseSchema(
  MemoryVerifyResultSchema,
);
export type MemoryVerifySuccess = typeof MemoryVerifySuccessSchema.Type;

export const MemoryDiffResultSchema = Schema.Struct({
  id: Schema.Number,
  conflict: Schema.Boolean,
  similarity: Schema.Number,
  added_terms: Schema.Array(Schema.String),
  removed_terms: Schema.Array(Schema.String),
  dropped: DroppedDetailsSchema,
});
export type MemoryDiffResult = typeof MemoryDiffResultSchema.Type;
export const MemoryDiffSuccessSchema = okResponseSchema(MemoryDiffResultSchema);
export type MemoryDiffSuccess = typeof MemoryDiffSuccessSchema.Type;

export const MemorySizeResultSchema = Schema.Struct({
  size: EmbeddingSizeReportSchema,
});
export type MemorySizeResult = typeof MemorySizeResultSchema.Type;
export const MemorySizeSuccessSchema = okResponseSchema(MemorySizeResultSchema);
export type MemorySizeSuccess = typeof MemorySizeSuccessSchema.Type;

export const MemoryDeleteResultSchema = Schema.Struct({
  deleted_from: Schema.String,
  id: Schema.Number,
  deleted: Schema.Boolean,
  existed: Schema.Boolean,
});
export type MemoryDeleteResult = typeof MemoryDeleteResultSchema.Type;
export const MemoryDeleteSuccessSchema = okResponseSchema(
  MemoryDeleteResultSchema,
);
export type MemoryDeleteSuccess = typeof MemoryDeleteSuccessSchema.Type;

export const MemoryDeleteManyResultSchema = Schema.Struct({
  deleted_from: Schema.String,
  requested_ids: Schema.Array(Schema.Number),
  deleted_ids: Schema.Array(Schema.Number),
  not_found: Schema.Array(Schema.Number),
  count: Schema.Number,
});
export type MemoryDeleteManyResult = typeof MemoryDeleteManyResultSchema.Type;
export const MemoryDeleteManySuccessSchema = okResponseSchema(
  MemoryDeleteManyResultSchema,
);
export type MemoryDeleteManySuccess = typeof MemoryDeleteManySuccessSchema.Type;

export const MemoryDeprecateResultSchema = Schema.Struct({
  written_to: Schema.String,
  status: MemoryStatusSchema,
  superseded_by: Schema.NullOr(Schema.Number),
  requested_ids: Schema.Array(Schema.Number),
  deprecated: Schema.Array(MemoryRowSchema),
  not_found: Schema.Array(Schema.Number),
  count: Schema.Number,
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
  count: Schema.Number,
  ids: Schema.Array(Schema.Number),
  expired: Schema.Array(MemoryRowSchema),
});
export type MemoryGcResult = typeof MemoryGcResultSchema.Type;
export const MemoryGcSuccessSchema = okResponseSchema(MemoryGcResultSchema);
export type MemoryGcSuccess = typeof MemoryGcSuccessSchema.Type;

export const MemoryStatsResultSchema = Schema.Struct({
  repository: Schema.String,
  total_memories: Schema.Number,
  active: Schema.Number,
  deprecated: Schema.Number,
  superseded: Schema.Number,
  breakdown_by_memory_type: Schema.Record(Schema.String, Schema.Number),
  breakdown_by_certainty: Schema.Record(Schema.String, Schema.Number),
  tag_frequency_map: Schema.Record(Schema.String, Schema.Number),
  oldest_memory: Schema.NullOr(
    Schema.Struct({
      id: Schema.Number,
      created_at: Schema.NullOr(Schema.String),
    }),
  ),
  memories_not_updated_over_90_days: Schema.Number,
  memories_with_no_tags: Schema.Number,
});
export type MemoryStatsResult = typeof MemoryStatsResultSchema.Type;
export const MemoryStatsSuccessSchema = okResponseSchema(
  MemoryStatsResultSchema,
);
export type MemoryStatsSuccess = typeof MemoryStatsSuccessSchema.Type;

export const MemoryDoctorFindingSchema = Schema.Struct({
  kind: Schema.String,
  ids: Schema.Array(Schema.Number),
  details: Schema.Record(Schema.String, Schema.Json),
});
export type MemoryDoctorFinding = typeof MemoryDoctorFindingSchema.Type;

export const MemoryDoctorResultSchema = Schema.Struct({
  repository: Schema.String,
  checked: Schema.Number,
  count: Schema.Number,
  findings: Schema.Array(MemoryDoctorFindingSchema),
  counts_by_kind: Schema.Record(Schema.String, Schema.Number),
});
export type MemoryDoctorResult = typeof MemoryDoctorResultSchema.Type;
export const MemoryDoctorSuccessSchema = okResponseSchema(
  MemoryDoctorResultSchema,
);
export type MemoryDoctorSuccess = typeof MemoryDoctorSuccessSchema.Type;

export const MemoryWriteSuccessSchema = okResponseSchema(
  MemoryWriteResultSchema,
);
export type MemoryWriteSuccess = typeof MemoryWriteSuccessSchema.Type;

export const MemoryRestoreResultSchema = Schema.Struct({
  written_to: Schema.String,
  id: Schema.Number,
  restored_revision_id: Schema.Number,
  memory: MemoryRowSchema,
  size: EmbeddingSizeReportSchema,
});
export type MemoryRestoreResult = typeof MemoryRestoreResultSchema.Type;
export const MemoryRestoreSuccessSchema = okResponseSchema(
  MemoryRestoreResultSchema,
);
export type MemoryRestoreSuccess = typeof MemoryRestoreSuccessSchema.Type;

import { Schema } from "effect";

import { okResponseSchema } from "../api/responses";
import { EmbeddingSizeReportSchema } from "../embedding";
import { MemoryRowSchema } from "../entities";

export const FactCheckResultSchema = Schema.Struct({
  similarity: Schema.Number,
  conflict: Schema.Boolean,
  added_terms: Schema.Array(Schema.String),
  removed_terms: Schema.Array(Schema.String),
});
export type FactCheckResult = typeof FactCheckResultSchema.Type;

export const ScoredMemoryRowSchema = Schema.Struct({
  ...MemoryRowSchema.fields,
  score: Schema.Number,
});
export type ScoredMemoryRow = typeof ScoredMemoryRowSchema.Type;

export const UpsertMatchInfoSchema = Schema.Struct({
  id: Schema.Number,
  score: Schema.Number,
  similarity: Schema.Number,
  memory_type: Schema.String,
  status: Schema.String,
  content_head: Schema.String,
});
export type UpsertMatchInfo = typeof UpsertMatchInfoSchema.Type;

export const MemoryWriteResultSchema = Schema.Struct({
  mode: Schema.optionalKey(Schema.String),
  written_to: Schema.String,
  id: Schema.Number,
  memory: MemoryRowSchema,
  size: Schema.optionalKey(EmbeddingSizeReportSchema),
  upsert_match: Schema.optionalKey(UpsertMatchInfoSchema),
  potential_conflicts: Schema.optionalKey(Schema.Array(ScoredMemoryRowSchema)),
});
export type MemoryWriteResult = typeof MemoryWriteResultSchema.Type;

export const ListRepositoriesResultSchema = Schema.Struct({
  repositories: Schema.Array(Schema.String),
  count: Schema.Number,
});
export type ListRepositoriesResult =
  typeof ListRepositoriesResultSchema.Type;
export const ListRepositoriesSuccessSchema = okResponseSchema(
  ListRepositoriesResultSchema,
);
export type ListRepositoriesSuccess =
  typeof ListRepositoriesSuccessSchema.Type;

export const MemoryGetSuccessSchema = okResponseSchema(MemoryRowSchema);
export type MemoryGetSuccess = typeof MemoryGetSuccessSchema.Type;

export const MemoryListResultSchema = Schema.Struct({
  count: Schema.Number,
  results: Schema.Array(MemoryRowSchema),
});
export type MemoryListResult = typeof MemoryListResultSchema.Type;
export const MemoryListSuccessSchema = okResponseSchema(
  MemoryListResultSchema,
);
export type MemoryListSuccess = typeof MemoryListSuccessSchema.Type;

export const MemoryQueryResultSchema = Schema.Struct({
  count: Schema.Number,
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
});
export type MemoryDiffResult = typeof MemoryDiffResultSchema.Type;
export const MemoryDiffSuccessSchema = okResponseSchema(
  MemoryDiffResultSchema,
);
export type MemoryDiffSuccess = typeof MemoryDiffSuccessSchema.Type;

export const MemorySizeResultSchema = Schema.Struct({
  size: EmbeddingSizeReportSchema,
});
export type MemorySizeResult = typeof MemorySizeResultSchema.Type;
export const MemorySizeSuccessSchema = okResponseSchema(
  MemorySizeResultSchema,
);
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

export const MemoryWriteSuccessSchema = okResponseSchema(
  MemoryWriteResultSchema,
);
export type MemoryWriteSuccess = typeof MemoryWriteSuccessSchema.Type;

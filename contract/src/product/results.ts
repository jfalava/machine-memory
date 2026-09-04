import { Schema } from "effect";

import { MemoryRowSchema } from "../entities";

export const FactCheckResultSchema = Schema.Struct({
  similarity: Schema.Number,
  conflict: Schema.Boolean,
  addedTerms: Schema.Array(Schema.String),
  removedTerms: Schema.Array(Schema.String),
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
  upsert_match: Schema.optionalKey(UpsertMatchInfoSchema),
  potential_conflicts: Schema.optionalKey(Schema.Array(ScoredMemoryRowSchema)),
});
export type MemoryWriteResult = typeof MemoryWriteResultSchema.Type;

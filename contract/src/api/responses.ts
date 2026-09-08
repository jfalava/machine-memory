import { Schema } from "effect";

import { MIGRATION_ITEM_STATUSES } from "../literals";

/** Shared failure body for API routes (and clients). */
export const ErrorBodySchema = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.String,
});
export type ErrorBody = typeof ErrorBodySchema.Type;

/** 401/404 style bodies that historically omit `ok`. */
export const SimpleErrorBodySchema = Schema.Struct({
  error: Schema.String,
});
export type SimpleErrorBody = typeof SimpleErrorBodySchema.Type;

export type DatabaseFailureGuidance = {
  readonly category:
    | "fts-query"
    | "pattern-complexity"
    | "sql-query"
    | "database-schema";
  readonly error: string;
  readonly correctableInput: boolean;
};

export function databaseFailureGuidance(
  cause: unknown,
): DatabaseFailureGuidance | undefined {
  const detail = String(cause).toLowerCase();
  if (
    detail.includes("fts5: syntax error") ||
    detail.includes("malformed match expression")
  ) {
    return {
      category: "fts-query",
      error:
        "Full-text query could not be parsed. Use simpler words and remove FTS punctuation or operators such as quotes, parentheses, '*', and NEAR.",
      correctableInput: true,
    };
  }
  if (
    detail.includes("like or glob pattern too complex") ||
    detail.includes("like pattern too complex") ||
    detail.includes("glob pattern too complex")
  ) {
    return {
      category: "pattern-complexity",
      error:
        "Database query failed because a LIKE or GLOB pattern was too complex. Retry with shorter path or query terms; for file suggestions, use shorter relative paths or basenames. If machine-memory generated the pattern, report this as a bug.",
      correctableInput: false,
    };
  }
  if (detail.includes("no such table") || detail.includes("no such column")) {
    return {
      category: "database-schema",
      error:
        "Database query references a missing table or column. Run `machine-memory migrate` for the selected backend, then retry. If the schema is current, report this as a machine-memory bug.",
      correctableInput: false,
    };
  }
  if (
    detail.includes("sql syntax error") ||
    (detail.includes("sqlite") && detail.includes("syntax error"))
  ) {
    return {
      category: "sql-query",
      error:
        "Database query SQL was rejected. Retry with simpler query terms. If machine-memory generated the SQL, report this as a bug rather than repeatedly retrying the same query.",
      correctableInput: false,
    };
  }
  return undefined;
}

export function okResponseSchema<S extends Schema.Top>(result: S) {
  return Schema.Struct({
    ok: Schema.Literal(true),
    result,
  });
}

/** POST /query run result */
export const QueryRunResultSchema = Schema.Struct({
  changes: Schema.Number,
  lastInsertRowid: Schema.Number,
});
export type QueryRunResult = typeof QueryRunResultSchema.Type;

/**
 * POST /query success envelope. `result` is operation-dependent JSON
 * (row, row array, or run metadata). Keep it open so the SQL gateway stays flexible.
 */
export const QuerySuccessSchema = okResponseSchema(Schema.Json);
export type QuerySuccess = typeof QuerySuccessSchema.Type;

export const MigrationItemSchema = Schema.Struct({
  source_id: Schema.Number,
  target_id: Schema.Number,
  status: Schema.Literals(MIGRATION_ITEM_STATUSES),
});
export type MigrationItem = typeof MigrationItemSchema.Type;

export const MigrationBatchResultSchema = Schema.Struct({
  processed: Schema.Number,
  inserted: Schema.Number,
  duplicates: Schema.Number,
  items: Schema.Array(MigrationItemSchema),
});
export type MigrationBatchResult = typeof MigrationBatchResultSchema.Type;

export const MigrationSuccessSchema = okResponseSchema(
  MigrationBatchResultSchema,
);
export type MigrationSuccess = typeof MigrationSuccessSchema.Type;

export const MigrationLinksResultSchema = Schema.Struct({
  updated: Schema.Number,
});
export type MigrationLinksResult = typeof MigrationLinksResultSchema.Type;

export const MigrationLinksSuccessSchema = okResponseSchema(
  MigrationLinksResultSchema,
);
export type MigrationLinksSuccess = typeof MigrationLinksSuccessSchema.Type;

export const VectorizeUpsertResultSchema = Schema.Struct({
  id: Schema.String,
  namespace: Schema.String,
  mutationId: Schema.String,
});
export type VectorizeUpsertResult = typeof VectorizeUpsertResultSchema.Type;

export const VectorizeUpsertSuccessSchema = okResponseSchema(
  VectorizeUpsertResultSchema,
);
export type VectorizeUpsertSuccess = typeof VectorizeUpsertSuccessSchema.Type;

export const VectorizeDeleteResultSchema = Schema.Struct({
  id: Schema.String,
  mutationId: Schema.String,
});
export type VectorizeDeleteResult = typeof VectorizeDeleteResultSchema.Type;

export const VectorizeDeleteSuccessSchema = okResponseSchema(
  VectorizeDeleteResultSchema,
);
export type VectorizeDeleteSuccess = typeof VectorizeDeleteSuccessSchema.Type;

/** Vectorize matches requested without vector values. Metadata may be absent. */
export const VectorizeMatchSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  score: Schema.Number.check(Schema.isFinite()),
  namespace: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export type VectorizeMatch = typeof VectorizeMatchSchema.Type;

export const VectorizeSearchResultSchema = Schema.Struct({
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  matches: Schema.Array(VectorizeMatchSchema),
});
export type VectorizeSearchResult = typeof VectorizeSearchResultSchema.Type;
export const VectorizeSearchSuccessSchema = okResponseSchema(
  VectorizeSearchResultSchema,
);
export type VectorizeSearchSuccess = typeof VectorizeSearchSuccessSchema.Type;

export const ApiSuccessSchema = okResponseSchema(Schema.Json);
export type ApiSuccess = typeof ApiSuccessSchema.Type;

export const ApiFailureSchema = ErrorBodySchema;
export type ApiFailure = typeof ApiFailureSchema.Type;

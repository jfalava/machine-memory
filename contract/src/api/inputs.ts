import { Schema } from "effect";

import {
  MemoryDocumentInputSchema,
  normalizeMemoryDocument,
  normalizeSearchLimit,
  RepositorySchema,
  SearchLimitInputSchema,
  type MemoryDocument,
} from "../entities";
import {
  CERTAINTY_LEVELS,
  DEFAULT_CERTAINTY,
  DEFAULT_MEMORY_STATUS,
  DEFAULT_MEMORY_TYPE,
  MAX_MIGRATION_LINKS,
  MAX_MIGRATION_ROWS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  QUERY_OPERATIONS,
  type Certainty,
  type MemoryStatus,
  type MemoryType,
} from "../literals";

const SqlParamSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Null,
]);

/** POST /query */
export const QueryRequestSchema = Schema.Struct({
  operation: Schema.Literals(QUERY_OPERATIONS),
  sql: Schema.NonEmptyString,
  params: Schema.Array(SqlParamSchema),
  repository: RepositorySchema,
});
export type QueryRequest = typeof QueryRequestSchema.Type;

const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** One row in POST /migrate (wire shape before defaults). */
export const MigrationRowInputSchema = Schema.Struct({
  source_id: PositiveIntSchema,
  content: Schema.NonEmptyString,
  tags: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.String),
  memory_type: Schema.optionalKey(Schema.Literals(MEMORY_TYPES)),
  status: Schema.optionalKey(Schema.Literals(MEMORY_STATUSES)),
  certainty: Schema.optionalKey(Schema.Literals(CERTAINTY_LEVELS)),
  superseded_by_source_id: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  source_agent: Schema.optionalKey(Schema.String),
  last_updated_by: Schema.optionalKey(Schema.String),
  update_count: NonNegativeIntSchema,
  refs: Schema.optionalKey(Schema.String),
  expires_after_days: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  created_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  updated_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type MigrationRowInput = typeof MigrationRowInputSchema.Type;

export type MigrationRow = {
  readonly source_id: number;
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memory_type: MemoryType;
  readonly status: MemoryStatus;
  readonly certainty: Certainty;
  readonly superseded_by_source_id: number | null;
  readonly source_agent: string;
  readonly last_updated_by: string;
  readonly update_count: number;
  readonly refs: string;
  readonly expires_after_days: number | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
};

function orEmpty(value: string | undefined): string {
  return value ?? "";
}

function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

export function normalizeMigrationRow(input: MigrationRowInput): MigrationRow {
  return {
    source_id: input.source_id,
    content: input.content,
    tags: orEmpty(input.tags),
    context: orEmpty(input.context),
    memory_type: input.memory_type ?? DEFAULT_MEMORY_TYPE,
    status: input.status ?? DEFAULT_MEMORY_STATUS,
    certainty: input.certainty ?? DEFAULT_CERTAINTY,
    superseded_by_source_id: orNull(input.superseded_by_source_id),
    source_agent: orEmpty(input.source_agent),
    last_updated_by: orEmpty(input.last_updated_by),
    update_count: input.update_count,
    refs: input.refs ?? "[]",
    expires_after_days: orNull(input.expires_after_days),
    created_at: orNull(input.created_at),
    updated_at: orNull(input.updated_at),
  };
}

/** POST /migrate */
export const MigrationRequestInputSchema = Schema.Struct({
  repository: RepositorySchema,
  rows: Schema.Array(MigrationRowInputSchema).check(
    Schema.isMaxLength(MAX_MIGRATION_ROWS),
  ),
});
export type MigrationRequestInput = typeof MigrationRequestInputSchema.Type;

export type MigrationRequest = {
  readonly repository: string;
  readonly rows: MigrationRow[];
};

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.length === 0) {
    return null;
  }
  return value;
}

export type MigrationRequestParseResult =
  | { readonly ok: true; readonly value: MigrationRequest }
  | { readonly ok: false; readonly error: string };

export function normalizeMigrationRequest(
  input: MigrationRequestInput,
): MigrationRequestParseResult {
  const rows = input.rows.map((row) => {
    const normalized = normalizeMigrationRow(row);
    return {
      ...normalized,
      created_at: emptyToNull(normalized.created_at),
      updated_at: emptyToNull(normalized.updated_at),
    };
  });
  const sourceIds = new Set<number>();
  for (const row of rows) {
    if (sourceIds.has(row.source_id)) {
      return {
        ok: false,
        error: `Duplicate source_id ${row.source_id}.`,
      };
    }
    sourceIds.add(row.source_id);
  }
  return {
    ok: true,
    value: {
      repository: input.repository,
      rows,
    },
  };
}

export const MigrationLinkSchema = Schema.Struct({
  target_id: PositiveIntSchema,
  superseded_by_target_id: PositiveIntSchema,
});
export type MigrationLink = typeof MigrationLinkSchema.Type;

/** POST /migrate/links */
export const MigrationLinksRequestSchema = Schema.Struct({
  repository: RepositorySchema,
  links: Schema.Array(MigrationLinkSchema).check(
    Schema.isMaxLength(MAX_MIGRATION_LINKS),
  ),
});
export type MigrationLinksRequest = typeof MigrationLinksRequestSchema.Type;

/** POST /vectorize/upsert */
export const VectorizeUpsertRequestInputSchema = MemoryDocumentInputSchema;
export type VectorizeUpsertRequestInput =
  typeof VectorizeUpsertRequestInputSchema.Type;
export type VectorizeUpsertRequest = MemoryDocument;

export function normalizeVectorizeUpsertRequest(
  input: VectorizeUpsertRequestInput,
): VectorizeUpsertRequest {
  return normalizeMemoryDocument(input);
}

/**
 * POST /vectorize/search
 * Optional filter fields: omit means no filter (matches prior API).
 */
export const VectorizeSearchRequestInputSchema = Schema.Struct({
  repository: RepositorySchema,
  query: Schema.NonEmptyString,
  top_k: SearchLimitInputSchema,
  status: Schema.optionalKey(Schema.String),
  memory_type: Schema.optionalKey(Schema.String),
  certainty: Schema.optionalKey(Schema.String),
});
export type VectorizeSearchRequestInput =
  typeof VectorizeSearchRequestInputSchema.Type;

export type VectorizeSearchRequest = {
  readonly repository: string;
  readonly query: string;
  readonly top_k: number;
  readonly status: string | undefined;
  readonly memory_type: string | undefined;
  readonly certainty: string | undefined;
};

export function normalizeVectorizeSearchRequest(
  input: VectorizeSearchRequestInput,
): VectorizeSearchRequest {
  return {
    repository: input.repository,
    query: input.query,
    top_k: normalizeSearchLimit(input.top_k),
    status: input.status,
    memory_type: input.memory_type,
    certainty: input.certainty,
  };
}

/** POST /vectorize/delete */
export const VectorizeDeleteRequestSchema = Schema.Struct({
  id: Schema.Union([Schema.NonEmptyString, Schema.Number]),
});
export type VectorizeDeleteRequest = typeof VectorizeDeleteRequestSchema.Type;

/** @deprecated alias kept for barrel clarity during migration */
export const MigrationRequestSchema = MigrationRequestInputSchema;
export const MigrationRowSchema = MigrationRowInputSchema;
export const VectorizeUpsertRequestSchema = VectorizeUpsertRequestInputSchema;
export const VectorizeSearchRequestSchema = VectorizeSearchRequestInputSchema;

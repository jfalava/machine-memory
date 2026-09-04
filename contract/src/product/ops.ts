/**
 * Product operation argument schemas (CLI ↔ MCP parity catalog).
 * API product routes will implement these; MCP gateway will forward them.
 */
import { Schema } from "effect";

import {
  CertaintySchema,
  MemoryStatusSchema,
  MemoryTypeSchema,
  OptionalTagsFilterSchema,
  RepositorySchema,
  SearchLimitInputSchema,
  normalizeSearchLimit,
} from "../entities";
import {
  DEFAULT_CERTAINTY,
  DEFAULT_MEMORY_STATUS,
  DEFAULT_MEMORY_TYPE,
  SEARCH_MODES,
  UPSERT_DEFAULT_MIN_SCORE,
  type Certainty,
  type MemoryStatus,
  type MemoryType,
  type SearchMode,
} from "../literals";

const optionalString = Schema.optionalKey(Schema.String);
const optionalBoolean = Schema.optionalKey(Schema.Boolean);
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const filterFields = {
  status: Schema.optionalKey(MemoryStatusSchema),
  memory_type: Schema.optionalKey(MemoryTypeSchema),
  certainty: Schema.optionalKey(CertaintySchema),
  tags: OptionalTagsFilterSchema,
};

export const ListRepositoriesArgsInputSchema = Schema.Struct({
  limit: SearchLimitInputSchema,
});
export type ListRepositoriesArgsInput =
  typeof ListRepositoriesArgsInputSchema.Type;
export type ListRepositoriesArgs = { readonly limit: number };
export function normalizeListRepositoriesArgs(
  input: ListRepositoriesArgsInput,
): ListRepositoriesArgs {
  return { limit: normalizeSearchLimit(input.limit) };
}

export const MemoryQueryArgsInputSchema = Schema.Struct({
  repository: RepositorySchema,
  query: Schema.NonEmptyString,
  limit: SearchLimitInputSchema,
  mode: Schema.optionalKey(Schema.Literals(SEARCH_MODES)),
  ...filterFields,
});
export type MemoryQueryArgsInput = typeof MemoryQueryArgsInputSchema.Type;
export type MemoryQueryArgs = {
  readonly repository: string;
  readonly query: string;
  readonly limit: number;
  readonly mode: SearchMode;
  readonly status?: MemoryStatus;
  readonly memory_type?: MemoryType;
  readonly certainty?: Certainty;
  readonly tags?: string;
};
export function normalizeMemoryQueryArgs(
  input: MemoryQueryArgsInput,
): MemoryQueryArgs {
  return {
    repository: input.repository,
    query: input.query,
    limit: normalizeSearchLimit(input.limit),
    mode: input.mode ?? "hybrid",
    status: input.status,
    memory_type: input.memory_type,
    certainty: input.certainty,
    tags: input.tags,
  };
}

export const MemoryGetArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  id: positiveInt,
});
export type MemoryGetArgs = typeof MemoryGetArgsSchema.Type;

export const MemoryListArgsInputSchema = Schema.Struct({
  repository: RepositorySchema,
  limit: SearchLimitInputSchema,
  ...filterFields,
});
export type MemoryListArgsInput = typeof MemoryListArgsInputSchema.Type;
export type MemoryListArgs = {
  readonly repository: string;
  readonly limit: number;
  readonly status?: MemoryStatus;
  readonly memory_type?: MemoryType;
  readonly certainty?: Certainty;
  readonly tags?: string;
};
export function normalizeMemoryListArgs(
  input: MemoryListArgsInput,
): MemoryListArgs {
  return {
    repository: input.repository,
    limit: normalizeSearchLimit(input.limit),
    status: input.status,
    memory_type: input.memory_type,
    certainty: input.certainty,
    tags: input.tags,
  };
}

export const MemorySuggestArgsInputSchema = Schema.Struct({
  repository: RepositorySchema,
  files: Schema.NonEmptyString,
  query: optionalString,
  limit: SearchLimitInputSchema,
  ...filterFields,
});
export type MemorySuggestArgsInput = typeof MemorySuggestArgsInputSchema.Type;
export type MemorySuggestArgs = {
  readonly repository: string;
  readonly files: string;
  readonly query?: string;
  readonly limit: number;
  readonly status?: MemoryStatus;
  readonly memory_type?: MemoryType;
  readonly certainty?: Certainty;
  readonly tags?: string;
};
export function normalizeMemorySuggestArgs(
  input: MemorySuggestArgsInput,
): MemorySuggestArgs {
  return {
    repository: input.repository,
    files: input.files,
    query: input.query,
    limit: normalizeSearchLimit(input.limit),
    status: input.status,
    memory_type: input.memory_type,
    certainty: input.certainty,
    tags: input.tags,
  };
}

export const MemoryVerifyArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  id: positiveInt,
  fact: Schema.NonEmptyString,
});
export type MemoryVerifyArgs = typeof MemoryVerifyArgsSchema.Type;

export const MemoryDiffArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  id: positiveInt,
  content: Schema.NonEmptyString,
});
export type MemoryDiffArgs = typeof MemoryDiffArgsSchema.Type;

export const MemoryAddArgsInputSchema = Schema.Struct({
  repository: RepositorySchema,
  content: Schema.NonEmptyString,
  tags: optionalString,
  context: optionalString,
  memory_type: Schema.optionalKey(MemoryTypeSchema),
  certainty: Schema.optionalKey(CertaintySchema),
  status: Schema.optionalKey(MemoryStatusSchema),
  expires_after_days: Schema.optionalKey(positiveInt),
  upsert_match: optionalString,
  force: optionalBoolean,
  upsert_threshold: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ),
});
export type MemoryAddArgsInput = typeof MemoryAddArgsInputSchema.Type;
export type MemoryAddArgs = {
  readonly repository: string;
  readonly content: string;
  readonly tags?: string;
  readonly context?: string;
  readonly memory_type: MemoryType;
  readonly certainty: Certainty;
  readonly status: MemoryStatus;
  readonly expires_after_days?: number;
  readonly upsert_match?: string;
  readonly force?: boolean;
  readonly upsert_threshold: number;
};
export function normalizeMemoryAddArgs(
  input: MemoryAddArgsInput,
): MemoryAddArgs {
  return {
    repository: input.repository,
    content: input.content,
    tags: input.tags,
    context: input.context,
    memory_type: input.memory_type ?? DEFAULT_MEMORY_TYPE,
    certainty: input.certainty ?? DEFAULT_CERTAINTY,
    status: input.status ?? DEFAULT_MEMORY_STATUS,
    expires_after_days: input.expires_after_days,
    upsert_match: input.upsert_match,
    force: input.force,
    upsert_threshold: input.upsert_threshold ?? UPSERT_DEFAULT_MIN_SCORE,
  };
}

export const MemoryUpdateArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  id: Schema.optionalKey(positiveInt),
  match: optionalString,
  content: Schema.optionalKey(Schema.NonEmptyString),
  tags: optionalString,
  context: optionalString,
  memory_type: Schema.optionalKey(MemoryTypeSchema),
  certainty: Schema.optionalKey(CertaintySchema),
  status: Schema.optionalKey(MemoryStatusSchema),
  expires_after_days: Schema.optionalKey(positiveInt),
  superseded_by: Schema.optionalKey(positiveInt),
});
export type MemoryUpdateArgs = typeof MemoryUpdateArgsSchema.Type;

export const MemorySizeArgsInputSchema = Schema.Struct({
  content: Schema.NonEmptyString,
  tags: optionalString,
  context: optionalString,
  memory_type: Schema.optionalKey(MemoryTypeSchema),
  certainty: Schema.optionalKey(CertaintySchema),
  status: Schema.optionalKey(MemoryStatusSchema),
});
export type MemorySizeArgsInput = typeof MemorySizeArgsInputSchema.Type;
export type MemorySizeArgs = {
  readonly content: string;
  readonly tags?: string;
  readonly context?: string;
  readonly memory_type: MemoryType;
  readonly certainty: Certainty;
  readonly status: MemoryStatus;
};
export function normalizeMemorySizeArgs(
  input: MemorySizeArgsInput,
): MemorySizeArgs {
  return {
    content: input.content,
    tags: input.tags,
    context: input.context,
    memory_type: input.memory_type ?? DEFAULT_MEMORY_TYPE,
    certainty: input.certainty ?? DEFAULT_CERTAINTY,
    status: input.status ?? DEFAULT_MEMORY_STATUS,
  };
}

export const MemoryDeleteArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  id: positiveInt,
});
export type MemoryDeleteArgs = typeof MemoryDeleteArgsSchema.Type;

/** Aliases for the catalog entrypoints. */
export const ListRepositoriesArgsSchema = ListRepositoriesArgsInputSchema;
export const MemoryQueryArgsSchema = MemoryQueryArgsInputSchema;
export const MemoryListArgsSchema = MemoryListArgsInputSchema;
export const MemorySuggestArgsSchema = MemorySuggestArgsInputSchema;
export const MemoryAddArgsSchema = MemoryAddArgsInputSchema;
export const MemorySizeArgsSchema = MemorySizeArgsInputSchema;

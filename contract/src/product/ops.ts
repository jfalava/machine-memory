/**
 * Product request schemas shared by API validation and MCP tool discovery.
 */
import { Schema } from "effect";

import {
  CertaintySchema,
  MemoryStatusSchema,
  MemoryTypeSchema,
  OptionalTagsFilterSchema,
  RepositorySchema as RepositoryInputSchema,
  SearchLimitInputSchema,
  normalizeSearchLimit,
} from "../entities";
import {
  DEFAULT_CERTAINTY,
  DEFAULT_MEMORY_STATUS,
  DEFAULT_MEMORY_TYPE,
  SEARCH_MODES,
  MAX_NAMESPACE_BYTES,
  SEARCH_LIMIT_MAX,
  SEARCH_LIMIT_DEFAULT,
  UPSERT_MIN_SIMILARITY,
  UPSERT_DEFAULT_MIN_SCORE,
  type Certainty,
  type MemoryStatus,
  type MemoryType,
  type SearchMode,
} from "../literals";

const RepositorySchema = RepositoryInputSchema.annotateKey({
  description: `GitHub repository owner/name, at most ${MAX_NAMESPACE_BYTES} UTF-8 bytes. Required for repository operations; call list_repositories first if unsure.`,
});

const searchLimit = SearchLimitInputSchema.annotateKey({
  description: `Maximum number of results, from 1 to ${SEARCH_LIMIT_MAX}; defaults to ${SEARCH_LIMIT_DEFAULT}.`,
});

const optionalString = Schema.optionalKey(Schema.String);
const optionalBoolean = Schema.optionalKey(Schema.Boolean);
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const memoryId = positiveInt.annotateKey({ description: "Numeric memory id." });

const filterFields = {
  status: Schema.optionalKey(MemoryStatusSchema),
  memory_type: Schema.optionalKey(MemoryTypeSchema),
  certainty: Schema.optionalKey(CertaintySchema),
  tags: OptionalTagsFilterSchema.annotateKey({
    description: "Filter tags by substring, case-insensitive.",
  }),
};

export const ListRepositoriesArgsInputSchema = Schema.Struct({
  limit: searchLimit,
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
  query: Schema.NonEmptyString.annotateKey({
    description: "The search query.",
  }),
  limit: searchLimit,
  mode: Schema.optionalKey(Schema.Literals(SEARCH_MODES)).annotateKey({
    description: "Search mode. Defaults to hybrid.",
  }),
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
  id: memoryId,
});
export type MemoryGetArgs = typeof MemoryGetArgsSchema.Type;

export const MemoryListArgsInputSchema = Schema.Struct({
  repository: RepositorySchema,
  limit: searchLimit,
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
  files: Schema.NonEmptyString.annotateKey({
    description: "Comma-separated file paths, e.g. src/auth.ts,src/routes.ts.",
  }),
  query: optionalString,
  limit: searchLimit,
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
  id: memoryId,
  fact: Schema.NonEmptyString.annotateKey({
    description: "The inferred fact to verify against the stored memory.",
  }),
});
export type MemoryVerifyArgs = typeof MemoryVerifyArgsSchema.Type;

export const MemoryDiffArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  id: memoryId,
  content: Schema.NonEmptyString.annotateKey({
    description:
      "Canonical memory content. Put commands, paths, keys, and exact identifiers first.",
  }),
});
export type MemoryDiffArgs = typeof MemoryDiffArgsSchema.Type;

export const MemoryAddArgsInputSchema = Schema.Struct({
  repository: RepositorySchema,
  content: Schema.NonEmptyString.annotateKey({
    description:
      "Canonical memory content. Put commands, paths, keys, and exact identifiers first.",
  }),
  tags: optionalString.annotateKey({
    description: "Comma-separated tags, e.g. area:cli,topic:backend.",
  }),
  context: optionalString.annotateKey({
    description: "Supporting context for the memory.",
  }),
  memory_type: Schema.optionalKey(MemoryTypeSchema),
  certainty: Schema.optionalKey(CertaintySchema),
  status: Schema.optionalKey(MemoryStatusSchema),
  expires_after_days: Schema.optionalKey(positiveInt).annotateKey({
    description: "Expire after N days. Only valid for status memories.",
  }),
  upsert_match: optionalString.annotateKey({
    description:
      "Resolve an existing memory by topic. A strong match is updated; a weak match refuses creation unless force is true.",
  }),
  force: optionalBoolean.annotateKey({
    description: "Create despite a weak upsert_match result.",
  }),
  upsert_threshold: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ).annotateKey({
    description: `Minimum upsert match score, default ${UPSERT_DEFAULT_MIN_SCORE}; similarity must also reach ${UPSERT_MIN_SIMILARITY}.`,
  }),
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
  id: Schema.optionalKey(memoryId),
  match: optionalString.annotateKey({
    description:
      "Topic query identifying the update target. Exactly one of id or match is required.",
  }),
  content: Schema.optionalKey(Schema.NonEmptyString),
  tags: optionalString.annotateKey({
    description: "Comma-separated tags, e.g. area:cli,topic:backend.",
  }),
  context: optionalString.annotateKey({
    description: "Supporting context for the memory.",
  }),
  memory_type: Schema.optionalKey(MemoryTypeSchema),
  certainty: Schema.optionalKey(CertaintySchema),
  status: Schema.optionalKey(MemoryStatusSchema),
  expires_after_days: Schema.optionalKey(positiveInt).annotateKey({
    description: "Expire after N days. Only valid for status memories.",
  }),
  superseded_by: Schema.optionalKey(positiveInt).annotateKey({
    description: "Id of the memory that supersedes this one.",
  }),
});
export type MemoryUpdateArgs = typeof MemoryUpdateArgsSchema.Type;

export const MemorySizeArgsInputSchema = Schema.Struct({
  content: Schema.NonEmptyString.annotateKey({
    description:
      "Canonical memory content. Put commands, paths, keys, and exact identifiers first.",
  }),
  tags: optionalString.annotateKey({
    description: "Comma-separated tags, e.g. area:cli,topic:backend.",
  }),
  context: optionalString.annotateKey({
    description: "Supporting context for the memory.",
  }),
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
  id: memoryId,
});
export type MemoryDeleteArgs = typeof MemoryDeleteArgsSchema.Type;

/** Aliases for the catalog entrypoints. */
export const ListRepositoriesArgsSchema = ListRepositoriesArgsInputSchema;
export const MemoryQueryArgsSchema = MemoryQueryArgsInputSchema;
export const MemoryListArgsSchema = MemoryListArgsInputSchema;
export const MemorySuggestArgsSchema = MemorySuggestArgsInputSchema;
export const MemoryAddArgsSchema = MemoryAddArgsInputSchema;
export const MemorySizeArgsSchema = MemorySizeArgsInputSchema;

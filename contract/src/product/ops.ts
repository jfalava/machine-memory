/**
 * Product request schemas shared by API validation and MCP tool discovery.
 */
import { Schema } from "effect";

import {
  CertaintySchema,
  MemoryContentSchema,
  MemoryStatusSchema,
  MemoryTypeSchema,
  OptionalTagsFilterSchema,
  RepositorySchema as RepositoryInputSchema,
  SearchLimitInputSchema,
  normalizeSearchLimit,
} from "../entities";
import { EvidenceSchema, ValidationGapsSchema } from "../evidence";
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
  EVIDENCE_KINDS,
  type Certainty,
  type EvidenceKind,
  type MemoryStatus,
  type MemoryType,
  type SearchMode,
} from "../literals";
import { COVERAGE_DIRECTORIES_MAX } from "../path-tags";

const RepositorySchema = RepositoryInputSchema.annotateKey({
  description: `Repository slug such as owner/name, @namespace/name or group/subgroup/name, at most ${MAX_NAMESPACE_BYTES} UTF-8 bytes. Required for repository operations; call list_repositories first if unsure.`,
});

const searchLimit = SearchLimitInputSchema.annotateKey({
  description: `Maximum number of results, from 1 to ${SEARCH_LIMIT_MAX}; defaults to ${SEARCH_LIMIT_DEFAULT}.`,
});

const optionalString = Schema.optionalKey(Schema.String);
const optionalBoolean = Schema.optionalKey(Schema.Boolean);
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const memoryId = positiveInt.annotateKey({ description: "Numeric memory id." });
const offset = Schema.optionalKey(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
).annotateKey({
  description: "Number of matching rows to skip; defaults to 0.",
});
const memoryIds = Schema.Array(memoryId)
  .check(Schema.isMinLength(1), Schema.isMaxLength(100))
  .annotateKey({ description: "One to 100 explicit numeric memory ids." });

const evidenceField = Schema.optionalKey(EvidenceSchema).annotateKey({
  description: `Kinds of evidence behind the claim: ${EVIDENCE_KINDS.join(", ")}. certainty verified requires at least one. Put sources and versions in refs or context. Not embedded.`,
});
const validationGapsField = Schema.optionalKey(
  ValidationGapsSchema,
).annotateKey({
  description:
    "Known limits of the validation, e.g. unconfirmed user intent or untested platforms. Not embedded.",
});

const allowDropField = optionalBoolean.annotateKey({
  description:
    "Set true to replace content even though the update drops a path, flag or symbol that no other active record mentions, or shares almost nothing with the stored content. Without it such an update is refused and the error names what would be lost.",
});

const sourceAgentField = Schema.optionalKey(
  Schema.String.check(Schema.isMaxLength(200)),
).annotateKey({
  description:
    "Who is making this write: the agent and its thread or session, such as amp:T-1234 or claude-code:<session id>. Stored as source_agent on a new memory and as last_updated_by on every write, so a later reader can tell which thread wrote a record. Defaults to the authenticated user.",
});

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
  offset,
});
export type ListRepositoriesArgsInput =
  typeof ListRepositoriesArgsInputSchema.Type;
export type ListRepositoriesArgs = {
  readonly limit: number;
  readonly offset: number;
};
export function normalizeListRepositoriesArgs(
  input: ListRepositoriesArgsInput,
): ListRepositoriesArgs {
  return {
    limit: normalizeSearchLimit(input.limit),
    offset: input.offset ?? 0,
  };
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
  ids: memoryIds,
});

export const MemoryHistoryArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  id: memoryId,
  limit: searchLimit,
  offset,
});
export type MemoryHistoryArgsInput = typeof MemoryHistoryArgsSchema.Type;
export type MemoryHistoryArgs = {
  readonly repository: string;
  readonly id: number;
  readonly limit: number;
  readonly offset: number;
};
export function normalizeMemoryHistoryArgs(
  input: MemoryHistoryArgsInput,
): MemoryHistoryArgs {
  return {
    repository: input.repository,
    id: input.id,
    limit: normalizeSearchLimit(input.limit),
    offset: input.offset ?? 0,
  };
}

export const MemoryListArgsInputSchema = Schema.Struct({
  repository: RepositorySchema,
  limit: searchLimit,
  offset,
  ...filterFields,
});
export type MemoryListArgsInput = typeof MemoryListArgsInputSchema.Type;
export type MemoryListArgs = {
  readonly repository: string;
  readonly limit: number;
  readonly offset: number;
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
    offset: input.offset ?? 0,
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

export const MemoryDiffArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  id: memoryId,
  content: MemoryContentSchema.annotateKey({
    description:
      "Canonical memory content. Put commands, paths, keys, and exact identifiers first.",
  }),
});

export const MemoryAddArgsInputSchema = Schema.Struct({
  repository: RepositorySchema,
  content: MemoryContentSchema.annotateKey({
    description:
      "Canonical memory content. Put commands, paths, keys, and exact identifiers first.",
  }),
  tags: optionalString.annotateKey({
    description: "Comma-separated tags, e.g. area:cli,topic:backend.",
  }),
  paths: optionalString.annotateKey({
    description:
      "Comma-separated paths of the files the memory is about, e.g. src/auth.ts,src/routes.ts. The repository's tag map adds the tags of every prefix that matches; the result lists them in path_tag_matches and the paths that matched nothing in unmatched_paths.",
  }),
  context: optionalString.annotateKey({
    description: "Supporting context for the memory.",
  }),
  memory_type: Schema.optionalKey(MemoryTypeSchema),
  certainty: Schema.optionalKey(CertaintySchema),
  evidence: evidenceField,
  validation_gaps: validationGapsField,
  status: Schema.optionalKey(MemoryStatusSchema),
  expires_after_days: Schema.optionalKey(positiveInt).annotateKey({
    description: "Expire after N days. Only valid for status memories.",
  }),
  upsert_match: optionalString.annotateKey({
    description:
      "Topic query that resolves an existing memory. A strong match is updated with this content; a weak match refuses the write and lists the candidates. Omit it with update_id or create_new.",
  }),
  update_id: Schema.optionalKey(memoryId).annotateKey({
    description:
      "Id of the active memory this content replaces: the same topic, restated. Fields you omit keep their stored values. Cannot be combined with upsert_match or create_new.",
  }),
  create_new: optionalBoolean.annotateKey({
    description:
      "Set true after reading the existing records when this is a different fact. Creates a new memory despite an upsert match or a near-duplicate.",
  }),
  allow_drop: allowDropField,
  source_agent: sourceAgentField,
  upsert_threshold: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ).annotateKey({
    description: `Minimum rank_score of a strong upsert match, default ${UPSERT_DEFAULT_MIN_SCORE}; text_overlap must also reach ${UPSERT_MIN_SIMILARITY}.`,
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
  readonly evidence?: readonly EvidenceKind[];
  readonly validation_gaps?: readonly string[];
  readonly status: MemoryStatus;
  readonly expires_after_days?: number;
  readonly upsert_match?: string;
  readonly update_id?: number;
  readonly create_new?: boolean;
  readonly allow_drop?: boolean;
  readonly source_agent?: string;
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
    evidence: input.evidence,
    validation_gaps: input.validation_gaps,
    status: input.status ?? DEFAULT_MEMORY_STATUS,
    expires_after_days: input.expires_after_days,
    upsert_match: input.upsert_match,
    update_id: input.update_id,
    create_new: input.create_new,
    allow_drop: input.allow_drop,
    source_agent: input.source_agent,
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
  content: Schema.optionalKey(MemoryContentSchema).annotateKey({
    description:
      "The whole new content. Omit it to change only the other fields; the stored content is then kept.",
  }),
  allow_drop: allowDropField,
  tags: optionalString.annotateKey({
    description:
      "Comma-separated tags that replace the stored tags, e.g. area:cli,topic:backend. To change some tags, use add_tags and remove_tags instead.",
  }),
  add_tags: optionalString.annotateKey({
    description:
      "Comma-separated tags to add to the stored tags. Cannot be combined with tags.",
  }),
  remove_tags: optionalString.annotateKey({
    description:
      "Comma-separated tags to remove from the stored tags. Cannot be combined with tags.",
  }),
  context: optionalString.annotateKey({
    description:
      'Supporting context that replaces the stored context; "" clears it.',
  }),
  memory_type: Schema.optionalKey(MemoryTypeSchema),
  certainty: Schema.optionalKey(CertaintySchema),
  evidence: evidenceField,
  validation_gaps: validationGapsField,
  add_validation_gaps: Schema.optionalKey(ValidationGapsSchema).annotateKey({
    description:
      "Validation gaps to append to the stored ones. Cannot be combined with validation_gaps.",
  }),
  remove_validation_gaps: Schema.optionalKey(ValidationGapsSchema).annotateKey({
    description:
      "Stored validation gaps to remove, by their exact text. Cannot be combined with validation_gaps.",
  }),
  status: Schema.optionalKey(MemoryStatusSchema),
  expires_after_days: Schema.optionalKey(positiveInt).annotateKey({
    description: "Expire after N days. Only valid for status memories.",
  }),
  superseded_by: Schema.optionalKey(positiveInt).annotateKey({
    description: "Id of the memory that supersedes this one.",
  }),
  expected_update_count: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ).annotateKey({
    description:
      "update_count from the read this update is based on. A different stored count refuses the update, so a concurrent change is not overwritten.",
  }),
  source_agent: sourceAgentField,
});

export const MemoryRestoreArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  id: memoryId,
  revision_id: memoryId.annotateKey({
    description:
      "Revision id from memory_history for this memory and repository.",
  }),
  expected_update_count: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
  ).annotateKey({
    description:
      "Use current_update_count from memory_history. A stale count refuses the restore; do not use the historical row's update_count.",
  }),
});

export const MemorySizeArgsInputSchema = Schema.Struct({
  content: MemoryContentSchema.annotateKey({
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

export const MemoryDeleteManyArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  ids: memoryIds,
});

export const MemoryDeprecateArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  ids: memoryIds,
  superseded_by: Schema.optionalKey(memoryId).annotateKey({
    description:
      "Id of the canonical memory replacing every target. Omit to mark targets deprecated without a replacement.",
  }),
  source_agent: sourceAgentField,
});

export const TagMapListArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  paths: optionalString.annotateKey({
    description:
      "Comma-separated file paths. When given, the result also reports the tags the map assigns to them, the prefix each path matched, and the paths that matched nothing.",
  }),
});

const pathPrefix = Schema.NonEmptyString.annotateKey({
  description:
    "Path prefix relative to the repository root, e.g. src/cli. It matches the path itself and everything under it.",
});

export const TagMapSetArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  path_prefix: pathPrefix,
  tags: Schema.NonEmptyString.annotateKey({
    description:
      "Comma-separated tags for memories about files under the prefix, e.g. area:cli,topic:commands. They replace the tags the prefix had.",
  }),
});

export const TagMapDeleteArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  path_prefix: pathPrefix,
});

export const MemoryCoverageArgsSchema = Schema.Struct({
  repository: RepositorySchema,
  directories: Schema.Array(Schema.String)
    .check(Schema.isMinLength(1), Schema.isMaxLength(COVERAGE_DIRECTORIES_MAX))
    .annotateKey({
      description: `Directory paths relative to the repository root, e.g. ["src/", "src/cli/"], at most ${COVERAGE_DIRECTORIES_MAX}. Leave out dependency and build output directories.`,
    }),
});

export const MemoryDoctorArgsSchema = Schema.Struct({
  repository: RepositorySchema,
});

export const MemoryStatsArgsSchema = Schema.Struct({
  repository: RepositorySchema,
});

export const MemoryGcArgsSchema = Schema.Struct({
  repository: RepositorySchema,
});

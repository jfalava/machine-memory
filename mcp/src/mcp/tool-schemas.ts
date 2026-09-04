import {
  CERTAINTY_LEVELS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  SEARCH_LIMIT_MAX,
} from "@machine-memory/contract";
import { Schema } from "effect";
import {
  describedString,
  mcpInputSchema,
  optionalEnum,
  optionalString,
  positiveInt,
} from "./schema-bridge";

function searchLimitField(description: string) {
  return Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: SEARCH_LIMIT_MAX }),
    ).annotate({ description }),
  );
}

export const repositoryField = describedString(
  "The GitHub repository (owner/name) whose memories to operate on.",
);

export const repositoryWriteField = describedString(
  "The GitHub repository (owner/name) to write this memory to. Required — no default. Call list_repositories to enumerate valid slugs before writing.",
);

export const repositoryOwnedField = describedString(
  "The GitHub repository (owner/name) the memory belongs to. Required — no default. Call list_repositories to enumerate valid slugs before writing.",
);

const filterFields = {
  status: optionalEnum(MEMORY_STATUSES, "Filter by memory status."),
  memory_type: optionalEnum(MEMORY_TYPES, "Filter by memory type."),
  certainty: optionalEnum(CERTAINTY_LEVELS, "Filter by certainty level."),
};

const tagsFilterField = {
  tags: optionalString(
    "Filter to memories whose tags contain this text (substring, case-insensitive).",
  ),
};

const ListRepositoriesArgs = Schema.Struct({
  limit: searchLimitField("Maximum number of repository slugs to return."),
});
export type ListRepositoriesArgs = Schema.Schema.Type<
  typeof ListRepositoriesArgs
>;
export const listRepositoriesInput = mcpInputSchema(ListRepositoriesArgs);

const MemoryQueryArgs = Schema.Struct({
  repository: repositoryField,
  query: describedString("The search query, e.g. 'deploy command'."),
  limit: searchLimitField("Maximum number of results to return."),
  mode: Schema.optionalKey(
    Schema.Literals(["keyword", "semantic", "hybrid"] as const).annotate({
      description: "Search mode; hybrid merges keyword and semantic results.",
    }),
  ),
  ...filterFields,
  ...tagsFilterField,
});
export type MemoryQueryArgs = Schema.Schema.Type<typeof MemoryQueryArgs>;
export const memoryQueryInput = mcpInputSchema(MemoryQueryArgs);

const MemoryGetArgs = Schema.Struct({
  repository: repositoryField,
  id: positiveInt("The numeric memory id to fetch."),
});
export type MemoryGetArgs = Schema.Schema.Type<typeof MemoryGetArgs>;
export const memoryGetInput = mcpInputSchema(MemoryGetArgs);

const MemoryListArgs = Schema.Struct({
  repository: repositoryField,
  limit: searchLimitField("Maximum number of results to return."),
  ...filterFields,
  ...tagsFilterField,
});
export type MemoryListArgs = Schema.Schema.Type<typeof MemoryListArgs>;
export const memoryListInput = mcpInputSchema(MemoryListArgs);

const MemorySuggestArgs = Schema.Struct({
  repository: repositoryField,
  files: describedString(
    "Comma-separated file paths to find relevant memories for, e.g. 'src/auth/jwt.ts,src/middleware/session.ts'.",
  ),
  query: optionalString(
    "Optional extra search terms scored together with the file-derived terms.",
  ),
  limit: searchLimitField("Maximum number of results to return."),
  ...filterFields,
  ...tagsFilterField,
});
export type MemorySuggestArgs = Schema.Schema.Type<typeof MemorySuggestArgs>;
export const memorySuggestInput = mcpInputSchema(MemorySuggestArgs);

const MemoryVerifyArgs = Schema.Struct({
  repository: repositoryField,
  id: positiveInt("The numeric memory id to check the fact against."),
  fact: describedString("The inferred fact to verify against the memory."),
});
export type MemoryVerifyArgs = Schema.Schema.Type<typeof MemoryVerifyArgs>;
export const memoryVerifyInput = mcpInputSchema(MemoryVerifyArgs);

const MemoryDiffArgs = Schema.Struct({
  repository: repositoryField,
  id: positiveInt("The numeric memory id to compare the new content against."),
  content: describedString("The proposed new content to diff."),
});
export type MemoryDiffArgs = Schema.Schema.Type<typeof MemoryDiffArgs>;
export const memoryDiffInput = mcpInputSchema(MemoryDiffArgs);

const MemoryAddArgs = Schema.Struct({
  repository: repositoryWriteField,
  content: describedString(
    "The canonical memory content. Put commands, paths, keys, and exact identifiers in the first sentence for retrieval.",
  ),
  tags: optionalString("Comma-separated tags, e.g. 'area:cli,topic:backend'."),
  context: optionalString("Supporting context for the memory."),
  memory_type: Schema.optionalKey(
    Schema.Literals(MEMORY_TYPES).annotate({ description: "Type of memory." }),
  ),
  certainty: Schema.optionalKey(
    Schema.Literals(CERTAINTY_LEVELS).annotate({
      description: "Certainty level.",
    }),
  ),
  status: Schema.optionalKey(
    Schema.Literals(MEMORY_STATUSES).annotate({
      description: "Memory status.",
    }),
  ),
  expires_after_days: Schema.optionalKey(
    positiveInt("Expire this status memory after N days."),
  ),
  upsert_match: optionalString(
    "Resolve an existing memory with this topic query first: a strong match is updated in place, otherwise a new record is created. A weak match refuses to create unless force is true.",
  ),
  force: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Create a new record even when upsert_match finds only a weak match.",
    }),
  ),
  upsert_threshold: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })).annotate({
      description:
        "Minimum match score (0-100, default 32) for an upsert_match hit to count as strong, alongside similarity >= 0.62.",
    }),
  ),
});
export type MemoryAddArgs = Schema.Schema.Type<typeof MemoryAddArgs>;
export const memoryAddInput = mcpInputSchema(MemoryAddArgs);

const MemoryUpdateArgs = Schema.Struct({
  repository: repositoryOwnedField,
  id: Schema.optionalKey(positiveInt("The numeric memory id to update.")),
  match: optionalString(
    "Resolve the update target with this topic query instead of id (exactly one of id or match is required). Errors when nothing active matches.",
  ),
  content: Schema.optionalKey(describedString("New canonical content.")),
  tags: optionalString("New comma-separated tags."),
  context: optionalString("New supporting context."),
  memory_type: optionalEnum(MEMORY_TYPES, "New memory type."),
  certainty: optionalEnum(CERTAINTY_LEVELS, "New certainty level."),
  status: optionalEnum(MEMORY_STATUSES, "New status."),
  expires_after_days: Schema.optionalKey(
    positiveInt("New expiry; only valid when the memory is a status memory."),
  ),
  superseded_by: Schema.optionalKey(
    positiveInt("Id of the memory that supersedes this one."),
  ),
});
export type MemoryUpdateArgs = Schema.Schema.Type<typeof MemoryUpdateArgs>;
export const memoryUpdateInput = mcpInputSchema(MemoryUpdateArgs);

const MemorySizeArgs = Schema.Struct({
  content: describedString(
    "The canonical memory content to measure. Put commands, paths, keys, and exact identifiers in the first sentence for retrieval.",
  ),
  tags: optionalString("Comma-separated tags, e.g. 'area:cli,topic:backend'."),
  context: optionalString("Supporting context for the memory."),
  memory_type: Schema.optionalKey(
    Schema.Literals(MEMORY_TYPES).annotate({ description: "Type of memory." }),
  ),
  certainty: Schema.optionalKey(
    Schema.Literals(CERTAINTY_LEVELS).annotate({
      description: "Certainty level.",
    }),
  ),
  status: Schema.optionalKey(
    Schema.Literals(MEMORY_STATUSES).annotate({
      description: "Memory status.",
    }),
  ),
});
export type MemorySizeArgs = Schema.Schema.Type<typeof MemorySizeArgs>;
export const memorySizeInput = mcpInputSchema(MemorySizeArgs);

const MemoryDeleteArgs = Schema.Struct({
  repository: repositoryOwnedField,
  id: positiveInt("The numeric memory id to delete."),
});
export type MemoryDeleteArgs = Schema.Schema.Type<typeof MemoryDeleteArgs>;
export const memoryDeleteInput = mcpInputSchema(MemoryDeleteArgs);

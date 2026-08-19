import { Effect } from "effect";
import { getFlagValue, hasFlag, printJson, usageError } from "../../cli-utils";
import {
  jsonNumber,
  jsonObject,
  type JsonObject,
  type JsonValue,
} from "../../json";
import { suggestTagsForPath } from "../../path-tags";
import type {
  MemoryDatabaseApi,
  MemoryDatabaseError,
} from "../../effect/database";
import {
  collectPositionalArgs,
  detectPotentialConflicts,
  findMemoryByMatch,
  findStatusCascadeCandidates,
  getMemoryById,
  hasMinimalOutput,
  mergeTagValues,
  parseContentFromFileFlag,
  parseIdSpec,
  parseIntegerFlag,
  parseRefsFlag,
  requireCertainty,
  requireMemoryType,
  stringValue,
} from "../shared";
import { compareFact } from "../features/memory/compare";
import {
  ADD_FLAGS_WITH_VALUES,
  ADD_USAGE,
  DEPRECATE_FLAGS_WITH_VALUES,
  DEPRECATE_USAGE,
  UPDATE_FLAGS_WITH_VALUES,
  UPDATE_USAGE,
} from "../features/memory/usage";
import { repositoryForCurrentDirectory } from "../../repository";
import { syncMemoryVector } from "../../effect/vector-sync";
import {
  analyzeBgeEmbedding,
  analyzeEmbeddingByBytes,
  assertBgeBreakdown,
  type BgeTokenBreakdown,
  type EmbeddingTextPart,
} from "../../effect/bge-tokenizer";
import {
  memoryVectorEmbeddingParts,
  type MemoryVectorDocument,
} from "../../effect/vectorize";
import { commandError, type CommandError } from "../../effect/errors";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";

const UPSERT_MIN_SIMILARITY = 0.62;
const UPSERT_MIN_SCORE = 32;

type AddExplicitFlags = {
  tags: boolean;
  context: boolean;
  memoryType: boolean;
  certainty: boolean;
  sourceAgent: boolean;
  updatedBy: boolean;
  refs: boolean;
  expiresAfterDays: boolean;
};

type AddMetadata = {
  mappedTags: string[];
  tags: string;
  memo: string;
  memoryType: string;
  certainty: string;
  sourceAgent: string;
  updatedBy: string;
  refs: string[];
  expiresAfterDays: number | null | undefined;
  explicit: AddExplicitFlags;
};

type UpdateTargets = {
  targetIds: number[];
  contentFromArg: string | undefined;
};

type UpdateSpec = {
  clause: string;
  value: string | number | null;
};

/**
 * Pure token-budget analysis for the embedding text a write would produce.
 * Uses the real BGE tokenizer when reachable and degrades to the Worker's
 * conservative byte estimate when it is not, so offline writes stay safe
 * without ever silently accepting text the embedding service would reject.
 */
function validateEmbeddingFit(
  command: string,
  label: string,
  parts: EmbeddingTextPart[],
): Effect.Effect<BgeTokenBreakdown, CommandError> {
  return Effect.tryPromise({
    try: async () => {
      let breakdown: BgeTokenBreakdown;
      try {
        breakdown = await analyzeBgeEmbedding(parts);
      } catch {
        breakdown = analyzeEmbeddingByBytes(parts);
      }
      assertBgeBreakdown(breakdown, label);
      return breakdown;
    },
    catch: (cause) =>
      commandError(
        command,
        cause instanceof Error
          ? cause.message
          : "Embedding validation failed.",
        cause,
      ),
  });
}

function addEmbeddingDocumentParts(
  content: string,
  metadata: AddMetadata,
): EmbeddingTextPart[] {
  return memoryVectorEmbeddingParts({
    id: "0",
    repository: repositoryForCurrentDirectory(),
    content,
    tags: metadata.tags,
    context: metadata.memo,
    memory_type: metadata.memoryType,
    status: "active",
    certainty: metadata.certainty,
  });
}

function prospectiveUpdateDocuments(
  args: string[],
  database: MemoryDatabaseApi,
  targetIds: number[],
  content: string,
): Effect.Effect<
  Array<{ id: number; document: MemoryVectorDocument }>,
  MemoryDatabaseError
> {
  const overrides = {
    tags: getFlagValue(args, "--tags"),
    context: getFlagValue(args, "--context"),
    memory_type: requireMemoryType(args),
    certainty: requireCertainty(args),
  };
  return Effect.forEach(targetIds, (id) =>
    getMemoryById(database, id).pipe(
      Effect.map((row) => {
        if (!row) {
          return null;
        }
        return {
          id,
          document: {
            id: String(id),
            repository:
              stringValue(row.repository) ?? repositoryForCurrentDirectory(),
            content,
            tags: overrides.tags ?? stringValue(row.tags),
            context: overrides.context ?? stringValue(row.context),
            memory_type:
              overrides.memory_type ??
              stringValue(row.memory_type, "convention"),
            status: stringValue(row.status, "active"),
            certainty:
              overrides.certainty ?? stringValue(row.certainty, "inferred"),
          } satisfies MemoryVectorDocument,
        };
      }),
    ),
  ).pipe(
    Effect.map((entries) =>
      entries.filter(
        (
          entry,
        ): entry is { id: number; document: MemoryVectorDocument } =>
          entry !== null,
      ),
    ),
  );
}

function resolveAddContent(
  args: string[],
  fileSystem: CommandContext["fileSystem"],
): Effect.Effect<string, unknown> {
  const positional = collectPositionalArgs(args, ADD_FLAGS_WITH_VALUES);
  const contentFromArg = positional[0];
  return parseContentFromFileFlag(args, fileSystem).pipe(
    Effect.map((contentFromFile) => {
      if (contentFromArg && contentFromFile !== undefined) {
        usageError(`Usage: ${ADD_USAGE}`);
      }
      const content = contentFromFile ?? contentFromArg;
      if (!content) {
        usageError(`Usage: ${ADD_USAGE}`);
      }
      return content;
    }),
  );
}

function resolveAddMetadata(
  args: string[],
  fileSystem: CommandContext["fileSystem"],
): Effect.Effect<AddMetadata, unknown> {
  const explicitTags = getFlagValue(args, "--tags");
  const pathContext = getFlagValue(args, "--path");
  const sourceAgent = getFlagValue(args, "--source-agent") ?? "";
  const explicitFlags: AddExplicitFlags = {
    tags: explicitTags !== undefined,
    context: getFlagValue(args, "--context") !== undefined,
    memoryType: getFlagValue(args, "--type") !== undefined,
    certainty: getFlagValue(args, "--certainty") !== undefined,
    sourceAgent: getFlagValue(args, "--source-agent") !== undefined,
    updatedBy: getFlagValue(args, "--updated-by") !== undefined,
    refs: getFlagValue(args, "--refs") !== undefined,
    expiresAfterDays: getFlagValue(args, "--expires-after-days") !== undefined,
  };
  return (
    pathContext
      ? suggestTagsForPath(fileSystem, pathContext)
      : Effect.succeed([])
  ).pipe(
    Effect.map((mappedTags) => ({
      mappedTags,
      tags: mergeTagValues(explicitTags, mappedTags),
      memo: getFlagValue(args, "--context") ?? "",
      memoryType: requireMemoryType(args) ?? "convention",
      certainty: requireCertainty(args) ?? "inferred",
      sourceAgent,
      updatedBy: getFlagValue(args, "--updated-by") ?? sourceAgent,
      refs: parseRefsFlag(args) ?? [],
      expiresAfterDays: parseIntegerFlag(args, "--expires-after-days"),
      explicit: explicitFlags,
    })),
  );
}

function parseAddUpsertQuery(args: string[]): string | undefined {
  const value = getFlagValue(args, "--upsert-match");
  if (hasFlag(args, "--upsert-match") && value === undefined) {
    usageError(`Usage: ${ADD_USAGE}`);
  }
  return value;
}

function shouldSetLastUpdatedBy(metadata: AddMetadata): boolean {
  return metadata.explicit.updatedBy || metadata.explicit.sourceAgent;
}

function upsertComparableText(content: string, metadata: AddMetadata): string {
  return [content, metadata.tags, metadata.memo].join(" ");
}

function isStrongUpsertMatch(
  matched: JsonObject,
  content: string,
  metadata: AddMetadata,
): boolean {
  const matchedText = [
    stringValue(matched.content),
    stringValue(matched.tags),
    stringValue(matched.context),
  ].join(" ");
  const incomingText = upsertComparableText(content, metadata);
  const similarity = compareFact(matchedText, incomingText).similarity;
  const score = Number(matched.score ?? 0);
  return similarity >= UPSERT_MIN_SIMILARITY && score >= UPSERT_MIN_SCORE;
}

function upsertUpdateSpecs(metadata: AddMetadata): UpdateSpec[] {
  const specs: (UpdateSpec | undefined)[] = [
    metadata.explicit.tags || metadata.mappedTags.length > 0
      ? { clause: "tags = ?", value: metadata.tags }
      : undefined,
    metadata.explicit.context
      ? { clause: "context = ?", value: metadata.memo }
      : undefined,
    metadata.explicit.memoryType
      ? { clause: "memory_type = ?", value: metadata.memoryType }
      : undefined,
    metadata.explicit.certainty
      ? { clause: "certainty = ?", value: metadata.certainty }
      : undefined,
    metadata.explicit.sourceAgent
      ? { clause: "source_agent = ?", value: metadata.sourceAgent }
      : undefined,
    metadata.explicit.refs
      ? { clause: "refs = ?", value: JSON.stringify(metadata.refs) }
      : undefined,
    metadata.explicit.expiresAfterDays
      ? {
          clause: "expires_after_days = ?",
          value: metadata.expiresAfterDays ?? null,
        }
      : undefined,
    shouldSetLastUpdatedBy(metadata)
      ? { clause: "last_updated_by = ?", value: metadata.updatedBy }
      : undefined,
  ];
  return specs.filter((spec): spec is UpdateSpec => spec !== undefined);
}

function updateFromAddPayload(
  database: MemoryDatabaseApi,
  targetId: number,
  content: string,
  metadata: AddMetadata,
): Effect.Effect<unknown, MemoryDatabaseError> {
  const sets = [
    "content = ?",
    "updated_at = datetime('now')",
    "update_count = COALESCE(update_count, 0) + 1",
  ];
  const params: (string | number | null)[] = [content];
  for (const spec of upsertUpdateSpecs(metadata)) {
    sets.push(spec.clause);
    params.push(spec.value);
  }
  return database.run(
    `UPDATE memories SET ${sets.join(", ")} WHERE repository = ? AND id = ?`,
    [...params, repositoryForCurrentDirectory(), targetId],
  );
}

function printUpsertResult(
  outputMode: CommandContext["outputMode"],
  mode: "created" | "updated",
  id: number,
  tokenReport?: BgeTokenBreakdown,
) {
  printCommandOutput(
    { command: "add", outputMode },
    tokenReport ? { mode, id, tokens: tokenReport } : { mode, id },
  );
}

function maybeHandleAddUpsert(
  database: MemoryDatabaseApi,
  options: {
    args: string[];
    content: string;
    metadata: AddMetadata;
    outputMode: CommandContext["outputMode"];
    tokenReport?: BgeTokenBreakdown;
  },
): Effect.Effect<boolean, MemoryDatabaseError> {
  const { args, content, metadata, outputMode, tokenReport } = options;
  const upsertQuery = parseAddUpsertQuery(args);
  if (upsertQuery === undefined) {
    return Effect.succeed(false);
  }
  return Effect.gen(function* () {
    const matched = yield* findMemoryByMatch(database, upsertQuery);
    if (matched && isStrongUpsertMatch(matched, content, metadata)) {
      const matchedId = Number(matched.id);
      yield* updateFromAddPayload(database, matchedId, content, metadata);
      const updated = yield* getMemoryById(database, matchedId);
      if (updated) {
        yield* syncMemoryVector(database, updated);
      }
      yield* Effect.sync(() =>
        printUpsertResult(outputMode, "updated", matchedId, tokenReport),
      );
      return true;
    }
    const createdResult = yield* addInsert(database, content, metadata);
    const createdId =
      jsonNumber(jsonObject(createdResult)?.lastInsertRowid) ?? 0;
    const created = yield* getMemoryById(database, createdId);
    if (created) {
      yield* syncMemoryVector(database, created);
    }
    yield* Effect.sync(() =>
      printUpsertResult(outputMode, "created", createdId, tokenReport),
    );
    return true;
  });
}

function detectAddConflicts(
  database: MemoryDatabaseApi,
  outputMode: CommandContext["outputMode"],
  content: string,
  metadata: AddMetadata,
): Effect.Effect<
  {
    includeConflicts: boolean;
    potentialConflicts: JsonObject[];
  },
  MemoryDatabaseError
> {
  const includeConflicts = !(
    outputMode.noConflicts || hasMinimalOutput(outputMode)
  );
  return includeConflicts
    ? detectPotentialConflicts(database, {
        content,
        tags: metadata.tags,
        context: metadata.memo,
      }).pipe(
        Effect.map((potentialConflicts) => ({
          includeConflicts,
          potentialConflicts,
        })),
      )
    : Effect.succeed({ includeConflicts, potentialConflicts: [] });
}

function addInsert(
  database: MemoryDatabaseApi,
  content: string,
  metadata: AddMetadata,
): Effect.Effect<JsonValue, MemoryDatabaseError> {
  return database.run(
    `INSERT INTO memories (
     repository, content, tags, context, memory_type, certainty, status, superseded_by,
     source_agent, last_updated_by, update_count, refs, expires_after_days
   ) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, 0, ?, ?)`,
    [
      repositoryForCurrentDirectory(),
      content,
      metadata.tags,
      metadata.memo,
      metadata.memoryType,
      metadata.certainty,
      metadata.sourceAgent,
      metadata.updatedBy,
      JSON.stringify(metadata.refs),
      metadata.expiresAfterDays ?? null,
    ],
  );
}

function attachTokenReport(
  payload: JsonObject,
  tokenReport: BgeTokenBreakdown | undefined,
): void {
  if (tokenReport) {
    Object.assign(payload, { tokens: tokenReport });
  }
}

function briefAddPayload(params: {
  createdId: number;
  conflictCount: number;
  statusCascadeCount: number;
  tokenReport?: BgeTokenBreakdown;
}): JsonObject {
  const payload: JsonObject = {
    id: params.createdId,
    status: "created",
    conflict_count: params.conflictCount,
    status_cascade_count: params.statusCascadeCount,
  };
  attachTokenReport(payload, params.tokenReport);
  return payload;
}

function printAddResult(params: {
  outputMode: CommandContext["outputMode"];
  createdId: number;
  created: JsonObject | null;
  content: string;
  metadata: AddMetadata;
  includeConflicts: boolean;
  potentialConflicts: JsonObject[];
  statusCascade: JsonObject[];
  tokenReport?: BgeTokenBreakdown;
}) {
  const {
    outputMode,
    createdId,
    created,
    content,
    metadata,
    includeConflicts,
    potentialConflicts,
    statusCascade,
    tokenReport,
  } = params;
  if (outputMode.jsonMin || outputMode.quiet) {
    printJson(
      tokenReport
        ? { id: createdId, tokens: tokenReport }
        : { id: createdId },
    );
    return;
  }
  if (outputMode.brief) {
    printJson(
      briefAddPayload({
        createdId,
        conflictCount: potentialConflicts.length,
        statusCascadeCount: statusCascade.length,
        tokenReport,
      }),
    );
    return;
  }

  const payload = {
    ...(created ?? {
      id: createdId,
      content,
      tags: metadata.tags,
      context: metadata.memo,
    }),
  } satisfies JsonObject;
  if (metadata.mappedTags.length > 0) {
    Object.assign(payload, { path_tag_suggestions: metadata.mappedTags });
  }
  if (includeConflicts) {
    Object.assign(payload, { potential_conflicts: potentialConflicts });
  }
  if (statusCascade.length > 0) {
    const staleIds = statusCascade.map((item) => Number(item.id));
    Object.assign(payload, {
      status_cascade: {
        overlapping_ids: staleIds,
        suggested_command: `machine-memory deprecate ${staleIds.join(",")} --superseded-by ${createdId}`,
      },
    });
  }
  if (tokenReport) {
    attachTokenReport(payload, tokenReport);
  }
  printCommandOutput({ command: "add", outputMode }, payload);
}

export function handleAddCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args, outputMode } = commandCtx;
    const database = requireDatabase(commandCtx);
    const content = yield* resolveAddContent(args, commandCtx.fileSystem);
    const metadata = yield* resolveAddMetadata(args, commandCtx.fileSystem);
    const embeddingBreakdown = yield* validateEmbeddingFit(
      "add",
      "Memory",
      addEmbeddingDocumentParts(content, metadata),
    );
    const tokenReport = hasFlag(args, "--token-report")
      ? embeddingBreakdown
      : undefined;
    if (
      yield* maybeHandleAddUpsert(database, {
        args,
        content,
        metadata,
        outputMode,
        tokenReport,
      })
    ) {
      return;
    }
    const conflictState = yield* detectAddConflicts(
      database,
      outputMode,
      content,
      metadata,
    );
    const result = yield* addInsert(database, content, metadata);
    const insertId = jsonNumber(jsonObject(result)?.lastInsertRowid) ?? 0;
    const created = yield* getMemoryById(database, insertId);
    const createdId = Number(created?.id ?? insertId);
    if (created) {
      yield* syncMemoryVector(database, created);
    }
    const statusCascade =
      metadata.memoryType === "status"
        ? yield* findStatusCascadeCandidates(database, metadata.tags, createdId)
        : [];
    yield* Effect.sync(() =>
      printAddResult({
        outputMode,
        createdId,
        created,
        content,
        metadata,
        includeConflicts: conflictState.includeConflicts,
        potentialConflicts: conflictState.potentialConflicts,
        statusCascade,
        tokenReport,
      }),
    );
  });
}

function resolveUpdateTargets(
  args: string[],
  database: MemoryDatabaseApi,
): Effect.Effect<UpdateTargets, MemoryDatabaseError> {
  const positional = collectPositionalArgs(args, UPDATE_FLAGS_WITH_VALUES);
  const matchQuery = getFlagValue(args, "--match");

  if (matchQuery !== undefined) {
    if (positional.length > 1) {
      usageError(`Usage: ${UPDATE_USAGE}`);
    }
    const contentFromArg = positional[0];
    return findMemoryByMatch(database, matchQuery).pipe(
      Effect.map((matched) => {
        const matchedId = matched ? jsonNumber(matched.id) : undefined;
        if (matchedId === undefined) {
          usageError(`No active memory matched --match "${matchQuery}".`);
        }
        return { targetIds: [matchedId], contentFromArg };
      }),
    );
  }

  const idRaw = positional[0];
  const contentFromArg = positional.slice(1).join(" ");
  if (!idRaw) {
    usageError(`Usage: ${UPDATE_USAGE}`);
  }
  return Effect.succeed({ targetIds: parseIdSpec(idRaw), contentFromArg });
}

function resolveUpdateContent(
  args: string[],
  contentFromArg: string | undefined,
  fileSystem: CommandContext["fileSystem"],
): Effect.Effect<string, unknown> {
  return parseContentFromFileFlag(args, fileSystem).pipe(
    Effect.map((contentFromFile) => {
      if (contentFromArg && contentFromFile !== undefined) {
        usageError(`Usage: ${UPDATE_USAGE}`);
      }
      const content = contentFromFile ?? contentFromArg;
      if (!content) {
        usageError(`Usage: ${UPDATE_USAGE}`);
      }
      return content;
    }),
  );
}

function optionalUpdateSpecs(args: string[]): UpdateSpec[] {
  const specs: UpdateSpec[] = [];
  const maybeSpecs: (UpdateSpec | undefined)[] = [
    (() => {
      const value = getFlagValue(args, "--tags");
      return value === undefined ? undefined : { clause: "tags = ?", value };
    })(),
    (() => {
      const value = getFlagValue(args, "--context");
      return value === undefined ? undefined : { clause: "context = ?", value };
    })(),
    (() => {
      const value = requireMemoryType(args);
      return value === undefined
        ? undefined
        : { clause: "memory_type = ?", value };
    })(),
    (() => {
      const value = requireCertainty(args);
      return value === undefined
        ? undefined
        : { clause: "certainty = ?", value };
    })(),
    (() => {
      const value = getFlagValue(args, "--updated-by");
      return value === undefined
        ? undefined
        : { clause: "last_updated_by = ?", value };
    })(),
    (() => {
      const value = parseRefsFlag(args);
      return value === undefined
        ? undefined
        : { clause: "refs = ?", value: JSON.stringify(value) };
    })(),
    (() => {
      const value = parseIntegerFlag(args, "--expires-after-days", {
        allowNullLiteral: true,
      });
      return value === undefined
        ? undefined
        : { clause: "expires_after_days = ?", value };
    })(),
  ];

  for (const spec of maybeSpecs) {
    if (spec) {
      specs.push(spec);
    }
  }
  return specs;
}

function updateSetsAndParams(args: string[], content: string) {
  const sets = [
    "content = ?",
    "updated_at = datetime('now')",
    "update_count = COALESCE(update_count, 0) + 1",
  ];
  const params: (string | number | null)[] = [content];
  for (const spec of optionalUpdateSpecs(args)) {
    sets.push(spec.clause);
    params.push(spec.value);
  }
  return { sets, params };
}

function runBatchMemoryUpdate(
  database: MemoryDatabaseApi,
  targetIds: number[],
  sets: string[],
  params: (string | number | null)[],
): Effect.Effect<
  { rows: JsonObject[]; missingIds: number[] },
  MemoryDatabaseError
> {
  return Effect.gen(function* () {
    const rows: JsonObject[] = [];
    const missingIds: number[] = [];
    for (const targetId of targetIds) {
      yield* database.run(
        `UPDATE memories SET ${sets.join(", ")} WHERE repository = ? AND id = ?`,
        [...params, repositoryForCurrentDirectory(), targetId],
      );
      const updated = yield* getMemoryById(database, targetId);
      if (updated) {
        rows.push(updated);
      } else {
        missingIds.push(targetId);
      }
    }
    return { rows, missingIds };
  });
}

export function handleUpdateCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args } = commandCtx;
    const database = requireDatabase(commandCtx);
    const { targetIds, contentFromArg } = yield* resolveUpdateTargets(
      args,
      database,
    );
    const content = yield* resolveUpdateContent(
      args,
      contentFromArg,
      commandCtx.fileSystem,
    );
    if (targetIds.length === 0) {
      usageError(`Usage: ${UPDATE_USAGE}`);
    }
    const tokenReportEnabled = hasFlag(args, "--token-report");
    const prospective = yield* prospectiveUpdateDocuments(
      args,
      database,
      targetIds,
      content,
    );
    const tokenBreakdowns = new Map<number, BgeTokenBreakdown>();
    for (const entry of prospective) {
      const breakdown = yield* validateEmbeddingFit(
        "update",
        `Memory ${entry.id}`,
        memoryVectorEmbeddingParts(entry.document),
      );
      if (tokenReportEnabled) {
        tokenBreakdowns.set(entry.id, breakdown);
      }
    }
    const { sets, params } = updateSetsAndParams(args, content);
    const { rows, missingIds } = yield* runBatchMemoryUpdate(
      database,
      targetIds,
      sets,
      params,
    );
    for (const row of rows) {
      yield* syncMemoryVector(database, row);
    }
    yield* Effect.sync(() => {
      if (targetIds.length === 1) {
        const payload = rows[0] ?? { error: "Not found" };
        const firstId = targetIds[0];
        if (tokenReportEnabled && firstId !== undefined) {
          const breakdown = tokenBreakdowns.get(firstId);
          if (breakdown) {
            Object.assign(payload, { tokens: breakdown });
          }
        }
        printCommandOutput(commandCtx, payload);
        return;
      }
      const payload: JsonObject = {
        updated: rows,
        not_found: missingIds,
        count: rows.length,
      };
      if (tokenReportEnabled && tokenBreakdowns.size > 0) {
        Object.assign(payload, {
          tokens: [...tokenBreakdowns.entries()].map(([id, breakdown]) => ({
            id,
            ...breakdown,
          })),
        });
      }
      printCommandOutput(commandCtx, payload);
    });
  });
}

function resolveDeprecateTargets(
  args: string[],
  database: MemoryDatabaseApi,
): Effect.Effect<number[], MemoryDatabaseError> {
  const positional = collectPositionalArgs(args, DEPRECATE_FLAGS_WITH_VALUES);
  const matchQuery = getFlagValue(args, "--match");

  if (matchQuery !== undefined) {
    if (positional.length > 0) {
      usageError(`Usage: ${DEPRECATE_USAGE}`);
    }
    return findMemoryByMatch(database, matchQuery).pipe(
      Effect.map((matched) => {
        const matchedId = matched ? jsonNumber(matched.id) : undefined;
        if (matchedId === undefined) {
          usageError(`No active memory matched --match "${matchQuery}".`);
        }
        return [matchedId];
      }),
    );
  }

  const idRaw = positional.join(",");
  if (!idRaw.trim()) {
    usageError(`Usage: ${DEPRECATE_USAGE}`);
  }
  return Effect.succeed(parseIdSpec(idRaw));
}

function deprecateSetsAndParams(args: string[], targetIds: number[]) {
  const supersededBy = parseIntegerFlag(args, "--superseded-by");
  if (
    supersededBy !== undefined &&
    targetIds.some((targetId) => supersededBy === targetId)
  ) {
    usageError("A memory cannot supersede itself.");
  }
  const updatedBy = getFlagValue(args, "--updated-by");
  const sets = [
    "status = ?",
    "superseded_by = ?",
    "updated_at = datetime('now')",
    "update_count = COALESCE(update_count, 0) + 1",
  ];
  const params: (string | number | null)[] = [
    supersededBy !== undefined ? "superseded_by" : "deprecated",
    supersededBy ?? null,
  ];
  if (updatedBy !== undefined) {
    sets.push("last_updated_by = ?");
    params.push(updatedBy);
  }
  return { sets, params };
}

export function handleDeprecateCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args } = commandCtx;
    const database = requireDatabase(commandCtx);
    const targetIds = yield* resolveDeprecateTargets(args, database);
    const { sets, params } = deprecateSetsAndParams(args, targetIds);
    const { rows, missingIds } = yield* runBatchMemoryUpdate(
      database,
      targetIds,
      sets,
      params,
    );
    for (const row of rows) {
      yield* syncMemoryVector(database, row);
    }
    yield* Effect.sync(() => {
      if (targetIds.length === 1) {
        printCommandOutput(commandCtx, rows[0] ?? { error: "Not found" });
        return;
      }
      printCommandOutput(commandCtx, {
        deprecated: rows,
        not_found: missingIds,
        count: rows.length,
      });
    });
  });
}

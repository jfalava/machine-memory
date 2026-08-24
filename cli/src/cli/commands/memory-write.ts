import { Effect } from "effect";
import { createInterface } from "node:readline/promises";
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
import {
  embeddingSizeReport,
  measureEmbeddingFit,
} from "../features/memory/size-report";

const UPSERT_MIN_SIMILARITY = 0.62;
const UPSERT_MIN_SCORE = 32;
const UPSERT_MIN_SCORE_ENV = "MACHINE_MEMORY_UPSERT_MIN_SCORE";

function defaultUpsertMinScore(): number {
  const raw = process.env[UPSERT_MIN_SCORE_ENV];
  if (raw === undefined) {
    return UPSERT_MIN_SCORE;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return UPSERT_MIN_SCORE;
  }
  return Math.min(100, Math.max(0, parsed));
}

function resolveUpsertMinScore(
  args: string[],
): Effect.Effect<number, CommandError> {
  const raw = getFlagValue(args, "--upsert-threshold");
  if (raw === undefined) {
    return Effect.succeed(defaultUpsertMinScore());
  }
  const parsed = Number(raw);
  if (
    raw.trim() === "" ||
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    parsed > 100
  ) {
    return Effect.fail(
      commandError(
        "add",
        "--upsert-threshold must be a number between 0 and 100.",
      ),
    );
  }
  return Effect.succeed(parsed);
}

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
  return measureEmbeddingFit(parts).pipe(
    Effect.mapError((cause) =>
      commandError(command, cause.message, cause.cause),
    ),
    Effect.flatMap((breakdown) =>
      Effect.try({
        try: () => {
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
      }),
    ),
  );
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

function addUpsertEmbeddingDocument(
  matched: JsonObject,
  content: string,
  metadata: AddMetadata,
): MemoryVectorDocument {
  return {
    id: String(jsonNumber(matched.id) ?? 0),
    repository:
      stringValue(matched.repository) ?? repositoryForCurrentDirectory(),
    content,
    tags:
      metadata.explicit.tags || metadata.mappedTags.length > 0
        ? metadata.tags
        : stringValue(matched.tags),
    context: metadata.explicit.context
      ? metadata.memo
      : stringValue(matched.context),
    memory_type: metadata.explicit.memoryType
      ? metadata.memoryType
      : stringValue(matched.memory_type, "convention"),
    status: stringValue(matched.status, "active"),
    certainty: metadata.explicit.certainty
      ? metadata.certainty
      : stringValue(matched.certainty, "inferred"),
  };
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
        (entry): entry is { id: number; document: MemoryVectorDocument } =>
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
  minScore: number = UPSERT_MIN_SCORE,
): boolean {
  const matchedText = [
    stringValue(matched.content),
    stringValue(matched.tags),
    stringValue(matched.context),
  ].join(" ");
  const incomingText = upsertComparableText(content, metadata);
  const similarity = compareFact(matchedText, incomingText).similarity;
  const score = Number(matched.score ?? 0);
  return similarity >= UPSERT_MIN_SIMILARITY && score >= minScore;
}

function contentHead(text: string, maxChars = 120): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > maxChars
    ? `${flattened.slice(0, maxChars)}…`
    : flattened;
}

function upsertMatchInfo(
  matched: JsonObject,
  content: string,
  metadata: AddMetadata,
): JsonObject {
  const matchedText = [
    stringValue(matched.content),
    stringValue(matched.tags),
    stringValue(matched.context),
  ].join(" ");
  return {
    id: Number(matched.id ?? 0),
    score: Number(matched.score ?? 0),
    similarity:
      Math.round(
        compareFact(matchedText, upsertComparableText(content, metadata))
          .similarity * 1000,
      ) / 1000,
    memory_type: stringValue(matched.memory_type, "convention"),
    status: stringValue(matched.status, "active"),
    content_head: contentHead(stringValue(matched.content)),
  };
}

type UpsertMatchSummary = {
  id: number;
  score: number;
  similarity: number;
};

function summarizeUpsertMatch(info: JsonObject): UpsertMatchSummary {
  return {
    id: Number(info.id ?? 0),
    score: Number(info.score ?? 0),
    similarity: Number(info.similarity ?? 0),
  };
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
  matchInfo?: JsonObject,
) {
  const payload: JsonObject = matchInfo
    ? { mode, id, upsert_match: matchInfo }
    : { mode, id };
  if (tokenReport) {
    Object.assign(payload, { tokens: tokenReport });
  }
  printCommandOutput({ command: "add", outputMode }, payload);
}

function weakMatchGateMessage(
  summary: UpsertMatchSummary,
  minScore: number,
): string {
  return (
    `Best match #${summary.id} is not a strong upsert match (score ${summary.score}, similarity ${summary.similarity}; ` +
    `needs score >= ${minScore} AND similarity >= ${UPSERT_MIN_SIMILARITY}). ` +
    `Refusing to silently ignore memory #${summary.id}: inspect it with 'add ... --upsert-match ... --dry-run', ` +
    `rerun with --force to create a new record anyway, or lower the bar with --upsert-threshold <0-100>.`
  );
}

function confirmWeakMatchCreate(summary: UpsertMatchSummary): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return rl
    .question(
      `Best match #${summary.id} is not a strong upsert match (score ${summary.score}, ` +
        `similarity ${summary.similarity}). Create a new record anyway? [y/N] `,
    )
    .then((answer) => /^y(es)?$/i.test(answer.trim()))
    .finally(() => rl.close());
}

function maybeHandleAddUpsert(
  database: MemoryDatabaseApi,
  options: {
    args: string[];
    content: string;
    metadata: AddMetadata;
    outputMode: CommandContext["outputMode"];
    tokenReportEnabled: boolean;
  },
) {
  const { args, content, metadata, outputMode, tokenReportEnabled } = options;
  const upsertQuery = parseAddUpsertQuery(args);
  if (upsertQuery === undefined) {
    return Effect.succeed(false);
  }
  const dryRun = hasFlag(args, "--dry-run");
  const force = hasFlag(args, "--force");
  return Effect.gen(function* () {
    const minScore = yield* resolveUpsertMinScore(args);
    const matched = yield* findMemoryByMatch(database, upsertQuery);
    const strong =
      matched !== null &&
      isStrongUpsertMatch(matched, content, metadata, minScore);
    const info =
      matched !== null ? upsertMatchInfo(matched, content, metadata) : null;
    const summary = info ? summarizeUpsertMatch(info) : null;

    if (dryRun) {
      return yield* runAddUpsertDryRun({
        content,
        metadata,
        outputMode,
        matched,
        strong,
        info,
        summary,
        minScore,
      });
    }

    if (matched !== null && !strong && summary) {
      yield* enforceWeakMatchGate(summary, minScore, force);
    }

    if (strong && matched) {
      return yield* runStrongUpsertUpdate({
        database,
        matched,
        content,
        metadata,
        outputMode,
        tokenReportEnabled,
      });
    }
    return yield* runUpsertCreate({
      database,
      content,
      metadata,
      outputMode,
      tokenReportEnabled,
      info,
    });
  });
}

function runStrongUpsertUpdate(params: {
  database: MemoryDatabaseApi;
  matched: JsonObject;
  content: string;
  metadata: AddMetadata;
  outputMode: CommandContext["outputMode"];
  tokenReportEnabled: boolean;
}): Effect.Effect<boolean, MemoryDatabaseError | CommandError> {
  return Effect.gen(function* () {
    const { database, matched, content, metadata, outputMode } = params;
    const matchedId = Number(matched.id);
    const breakdown = yield* validateEmbeddingFit(
      "add",
      `Memory ${matchedId}`,
      memoryVectorEmbeddingParts(
        addUpsertEmbeddingDocument(matched, content, metadata),
      ),
    );
    yield* updateFromAddPayload(database, matchedId, content, metadata);
    const updated = yield* getMemoryById(database, matchedId);
    if (updated) {
      yield* syncMemoryVector(database, updated);
    }
    yield* Effect.sync(() =>
      printUpsertResult(
        outputMode,
        "updated",
        matchedId,
        params.tokenReportEnabled ? breakdown : undefined,
      ),
    );
    return true;
  });
}

function runUpsertCreate(params: {
  database: MemoryDatabaseApi;
  content: string;
  metadata: AddMetadata;
  outputMode: CommandContext["outputMode"];
  tokenReportEnabled: boolean;
  info: JsonObject | null;
}): Effect.Effect<boolean, MemoryDatabaseError | CommandError> {
  return Effect.gen(function* () {
    const { database, content, metadata, outputMode } = params;
    const breakdown = yield* validateEmbeddingFit(
      "add",
      "Memory",
      addEmbeddingDocumentParts(content, metadata),
    );
    const createdResult = yield* addInsert(database, content, metadata);
    const createdId =
      jsonNumber(jsonObject(createdResult)?.lastInsertRowid) ?? 0;
    const created = yield* getMemoryById(database, createdId);
    if (created) {
      yield* syncMemoryVector(database, created);
    }
    yield* Effect.sync(() =>
      printUpsertResult(
        outputMode,
        "created",
        createdId,
        params.tokenReportEnabled ? breakdown : undefined,
        params.info ?? undefined,
      ),
    );
    return true;
  });
}

type AddUpsertDryRunParams = {
  content: string;
  metadata: AddMetadata;
  outputMode: CommandContext["outputMode"];
  matched: JsonObject | null;
  strong: boolean;
  info: JsonObject | null;
  summary: UpsertMatchSummary | null;
  minScore: number;
};

function addUpsertDryRunPayload(
  params: AddUpsertDryRunParams,
  size: BgeTokenBreakdown,
): JsonObject {
  const { strong, info, summary, minScore } = params;
  const payload: JsonObject = {
    command: "add",
    dry_run: true,
    action: strong ? "update" : "create",
  };
  if (info) {
    Object.assign(payload, { would_match: info });
  }
  if (!strong && summary) {
    Object.assign(payload, {
      note: `Best match #${summary.id} is not a strong upsert match (score ${summary.score}, similarity ${summary.similarity}; needs score >= ${minScore} AND similarity >= ${UPSERT_MIN_SIMILARITY}); without --force this write creates a NEW record instead of updating #${summary.id}.`,
    });
  }
  Object.assign(payload, { size: embeddingSizeReport(size) });
  return payload;
}

function runAddUpsertDryRun(
  params: AddUpsertDryRunParams,
): Effect.Effect<boolean, MemoryDatabaseError | CommandError> {
  return Effect.gen(function* () {
    const prospectiveParts =
      params.strong && params.matched
        ? memoryVectorEmbeddingParts(
            addUpsertEmbeddingDocument(
              params.matched,
              params.content,
              params.metadata,
            ),
          )
        : addEmbeddingDocumentParts(params.content, params.metadata);
    const size = yield* measureEmbeddingFit(prospectiveParts);
    yield* Effect.sync(() => {
      printCommandOutput(
        { command: "add", outputMode: params.outputMode },
        addUpsertDryRunPayload(params, size),
      );
      if (!size.within_limit) {
        process.exitCode = 1;
      }
    });
    return true;
  });
}

function enforceWeakMatchGate(
  summary: UpsertMatchSummary,
  minScore: number,
  force: boolean,
): Effect.Effect<void, CommandError> {
  if (force) {
    return Effect.void;
  }
  const refusal = () =>
    commandError("add", weakMatchGateMessage(summary, minScore));
  if (!process.stdin.isTTY) {
    return Effect.fail(refusal());
  }
  return Effect.gen(function* () {
    const confirmed = yield* Effect.tryPromise({
      try: () => confirmWeakMatchCreate(summary),
      catch: () => refusal(),
    });
    if (!confirmed) {
      return yield* Effect.fail(refusal());
    }
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
      tokenReport ? { id: createdId, tokens: tokenReport } : { id: createdId },
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

function runAddDryRun(
  commandCtx: CommandContext,
  content: string,
  metadata: AddMetadata,
): Effect.Effect<void, CommandError> {
  return Effect.gen(function* () {
    const size = yield* measureEmbeddingFit(
      addEmbeddingDocumentParts(content, metadata),
    );
    yield* Effect.sync(() => {
      printCommandOutput(
        { command: "add", outputMode: commandCtx.outputMode },
        {
          command: "add",
          dry_run: true,
          action: "create",
          size: embeddingSizeReport(size),
        } satisfies JsonObject,
      );
      if (!size.within_limit) {
        process.exitCode = 1;
      }
    });
  });
}

function runPlainAddInsert(params: {
  database: MemoryDatabaseApi;
  commandCtx: CommandContext;
  content: string;
  metadata: AddMetadata;
  tokenReport: BgeTokenBreakdown | undefined;
  conflictState: {
    includeConflicts: boolean;
    potentialConflicts: JsonObject[];
  };
}): Effect.Effect<void, MemoryDatabaseError | CommandError> {
  const { database, commandCtx, content, metadata } = params;
  return Effect.gen(function* () {
    const { outputMode } = commandCtx;
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
        includeConflicts: params.conflictState.includeConflicts,
        potentialConflicts: params.conflictState.potentialConflicts,
        statusCascade,
        tokenReport: params.tokenReport,
      }),
    );
  });
}

export function handleAddCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args, outputMode } = commandCtx;
    const database = requireDatabase(commandCtx);
    const content = yield* resolveAddContent(args, commandCtx.fileSystem);
    const metadata = yield* resolveAddMetadata(args, commandCtx.fileSystem);
    const tokenReportEnabled = hasFlag(args, "--token-report");
    if (
      yield* maybeHandleAddUpsert(database, {
        args,
        content,
        metadata,
        outputMode,
        tokenReportEnabled,
      })
    ) {
      return;
    }
    if (hasFlag(args, "--dry-run")) {
      yield* runAddDryRun(commandCtx, content, metadata);
      return;
    }
    const embeddingBreakdown = yield* validateEmbeddingFit(
      "add",
      "Memory",
      addEmbeddingDocumentParts(content, metadata),
    );
    const tokenReport = tokenReportEnabled ? embeddingBreakdown : undefined;
    const conflictState = yield* detectAddConflicts(
      database,
      outputMode,
      content,
      metadata,
    );
    yield* runPlainAddInsert({
      database,
      commandCtx,
      content,
      metadata,
      tokenReport,
      conflictState,
    });
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

function printSingleUpdateResult(params: {
  commandCtx: CommandContext;
  firstId: number | undefined;
  row: JsonObject | undefined;
  tokenReportEnabled: boolean;
  tokenBreakdowns: Map<number, BgeTokenBreakdown>;
}): void {
  const { commandCtx, firstId, row, tokenReportEnabled, tokenBreakdowns } =
    params;
  const { outputMode } = commandCtx;
  if (hasMinimalOutput(outputMode)) {
    const breakdown =
      firstId !== undefined ? tokenBreakdowns.get(firstId) : undefined;
    if (outputMode.brief) {
      const compact: JsonObject = { id: firstId, status: "updated" };
      if (breakdown) {
        Object.assign(compact, { tokens: breakdown });
      }
      printJson(compact);
      return;
    }
    printJson({ id: firstId });
    return;
  }
  const payload = row ?? { error: "Not found" };
  if (
    tokenReportEnabled &&
    firstId !== undefined &&
    "error" in payload === false
  ) {
    const breakdown = tokenBreakdowns.get(firstId);
    if (breakdown) {
      Object.assign(payload, { tokens: breakdown });
    }
  }
  printCommandOutput(commandCtx, payload);
}

function printUpdateResults(params: {
  commandCtx: CommandContext;
  targetIds: number[];
  rows: JsonObject[];
  missingIds: number[];
  tokenReportEnabled: boolean;
  tokenBreakdowns: Map<number, BgeTokenBreakdown>;
}): void {
  const {
    commandCtx,
    targetIds,
    rows,
    missingIds,
    tokenReportEnabled,
    tokenBreakdowns,
  } = params;
  const { outputMode } = commandCtx;
  if (targetIds.length === 1) {
    printSingleUpdateResult({
      commandCtx,
      firstId: targetIds[0],
      row: rows[0],
      tokenReportEnabled,
      tokenBreakdowns,
    });
    return;
  }
  if (hasMinimalOutput(outputMode)) {
    printJson({
      updated_ids: rows.map((row) => Number(row.id)),
      not_found: missingIds,
      count: rows.length,
    });
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
}

function runUpdateDryRun(
  commandCtx: CommandContext,
  prospective: Array<{ id: number; document: MemoryVectorDocument }>,
): Effect.Effect<void, CommandError> {
  return Effect.gen(function* () {
    const targets: JsonObject[] = [];
    let anyOverBudget = false;
    for (const entry of prospective) {
      const size = yield* measureEmbeddingFit(
        memoryVectorEmbeddingParts(entry.document),
      );
      anyOverBudget = anyOverBudget || !size.within_limit;
      targets.push({ id: entry.id, size: embeddingSizeReport(size) });
    }
    yield* Effect.sync(() => {
      printCommandOutput(commandCtx, {
        command: "update",
        dry_run: true,
        count: targets.length,
        targets,
      });
      if (anyOverBudget) {
        process.exitCode = 1;
      }
    });
  });
}

function validateProspectiveUpdates(
  prospective: Array<{ id: number; document: MemoryVectorDocument }>,
  tokenReportEnabled: boolean,
): Effect.Effect<Map<number, BgeTokenBreakdown>, CommandError> {
  return Effect.gen(function* () {
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
    return tokenBreakdowns;
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
    if (hasFlag(args, "--dry-run")) {
      yield* runUpdateDryRun(commandCtx, prospective);
      return;
    }
    const tokenBreakdowns = yield* validateProspectiveUpdates(
      prospective,
      tokenReportEnabled,
    );
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
    yield* Effect.sync(() =>
      printUpdateResults({
        commandCtx,
        targetIds,
        rows,
        missingIds,
        tokenReportEnabled,
        tokenBreakdowns,
      }),
    );
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

function printDeprecateResults(params: {
  commandCtx: CommandContext;
  supersededByRequested: boolean;
  targetIds: number[];
  rows: JsonObject[];
  missingIds: number[];
}): void {
  const { commandCtx, supersededByRequested, targetIds, rows, missingIds } =
    params;
  const { outputMode } = commandCtx;
  if (hasMinimalOutput(outputMode)) {
    if (targetIds.length === 1) {
      const firstId = targetIds[0];
      if (outputMode.brief) {
        printJson({
          id: firstId,
          status: supersededByRequested ? "superseded_by" : "deprecated",
        });
      } else {
        printJson({ id: firstId });
      }
    } else {
      printJson({
        deprecated_ids: rows.map((row) => Number(row.id)),
        not_found: missingIds,
        count: rows.length,
      });
    }
    return;
  }
  if (targetIds.length === 1) {
    printCommandOutput(commandCtx, rows[0] ?? { error: "Not found" });
    return;
  }
  printCommandOutput(commandCtx, {
    deprecated: rows,
    not_found: missingIds,
    count: rows.length,
  });
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
    yield* Effect.sync(() =>
      printDeprecateResults({
        commandCtx,
        supersededByRequested: hasFlag(args, "--superseded-by"),
        targetIds,
        rows,
        missingIds,
      }),
    );
  });
}

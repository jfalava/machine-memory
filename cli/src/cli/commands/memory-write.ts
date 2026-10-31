import { createInterface } from "node:readline/promises";

import {
  droppedDetails,
  hasDroppedDetails,
  type EvidenceKind,
  compareMemoryFact,
  UPSERT_DEFAULT_MIN_SCORE,
  UPSERT_MIN_SIMILARITY,
} from "@machine-memory/contract";
import { Effect } from "effect";

import { getFlagValue, hasFlag, printJson, usageError } from "../../cli-utils";
import {
  assertBgeBreakdown,
  type BgeTokenBreakdown,
  type EmbeddingTextPart,
} from "../../effect/bge-tokenizer";
import type {
  MemoryDatabaseApi,
  MemoryDatabaseError,
} from "../../effect/database";
import { commandError, type CommandError } from "../../effect/errors";
import {
  memoryVectorEmbeddingParts,
  type MemoryVectorDocument,
} from "../../effect/vectorize";
import {
  jsonNumber,
  jsonObject,
  type JsonObject,
  type JsonValue,
} from "../../json";
import { suggestTagsForPath } from "../../path-tags";
import { repositoryForCurrentDirectory } from "../../repository";
import {
  assertEvidenceWrite,
  parseEvidenceFlag,
  parseStoredEvidence,
  parseValidationGapsFlag,
} from "../features/memory/evidence";
import {
  embeddingSizeReport,
  measureEmbeddingFit,
} from "../features/memory/size-report";
import {
  ADD_USAGE,
  DEPRECATE_USAGE,
  UPDATE_USAGE,
} from "../features/memory/usage";
import { requireDatabase, type CommandContext } from "../runtime/context";
import {
  contentSnippet,
  minimalResultSummary,
  printCommandOutput,
} from "../runtime/output";
import {
  detectPotentialConflicts,
  assertWritableRepository,
  findMemoryByMatch,
  findReviewCandidates,
  findStatusCascadeCandidates,
  getMemoryById,
  hasMinimalOutput,
  mergeTagValues,
  normalizeCertaintyValue,
  normalizeSqliteRow,
  parseContentFromFileFlag,
  parseIdSpec,
  parseIntegerFlag,
  parseRefsFlag,
  requireCertainty,
  requireMemoryType,
  stringValue,
} from "../shared";

const UPSERT_MIN_SCORE_ENV = "MACHINE_MEMORY_UPSERT_MIN_SCORE";

function defaultUpsertMinScore(): number {
  const raw = process.env[UPSERT_MIN_SCORE_ENV];
  if (raw === undefined) {
    return UPSERT_DEFAULT_MIN_SCORE;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return UPSERT_DEFAULT_MIN_SCORE;
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
  /** undefined when the flag was omitted; [] clears on an upsert update. */
  evidence: EvidenceKind[] | undefined;
  validationGaps: string[] | undefined;
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

type ProspectiveUpdate = {
  id: number;
  updateCount: number;
  previous: JsonObject;
  document: MemoryVectorDocument;
};

/** What a write loses from the old content and which records may depend on it. */
type Reconciliation = {
  id: number;
  dropped?: JsonObject;
  reviewCandidates: JsonObject[];
};

function droppedFor(
  previous: JsonObject,
  content: string,
): JsonObject | undefined {
  const dropped = droppedDetails(stringValue(previous.content), content);
  return hasDroppedDetails(dropped)
    ? {
        identifiers: [...dropped.identifiers],
        sentences: [...dropped.sentences],
      }
    : undefined;
}

function reconcileWrite(
  database: MemoryDatabaseApi,
  previous: JsonObject,
  content: string,
): Effect.Effect<Reconciliation, MemoryDatabaseError> {
  const id = Number(previous.id);
  if (stringValue(previous.content) === content) {
    return Effect.succeed({ id, reviewCandidates: [] });
  }
  return findReviewCandidates(database, [previous]).pipe(
    Effect.map((reviewCandidates) => ({
      id,
      dropped: droppedFor(previous, content),
      reviewCandidates,
    })),
  );
}

/** Full output carries summaries; minimal output carries only ids. */
function reconciliationFields(
  reconciliation: Reconciliation | undefined,
  minimal: boolean,
): JsonObject {
  const fields: JsonObject = {};
  if (!reconciliation) {
    return fields;
  }
  if (reconciliation.dropped) {
    fields.dropped = reconciliation.dropped;
  }
  if (reconciliation.reviewCandidates.length > 0) {
    if (minimal) {
      fields.review_candidate_ids = reconciliation.reviewCandidates.map((row) =>
        Number(row.id),
      );
    } else {
      fields.review_candidates =
        reconciliation.reviewCandidates.map(minimalResultSummary);
    }
  }
  return fields;
}

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
): Effect.Effect<ProspectiveUpdate[], MemoryDatabaseError> {
  const overrides = {
    tags: getFlagValue(args, "--tags"),
    context: getFlagValue(args, "--context"),
    memory_type: requireMemoryType(args),
    certainty: requireCertainty(args),
  };
  const evidence = parseEvidenceFlag(args);
  return Effect.forEach(targetIds, (id) =>
    getMemoryById(database, id).pipe(
      Effect.map((row) => {
        if (!row) {
          return null;
        }
        assertEvidenceWrite(
          { certainty: overrides.certainty, evidence },
          existingEvidence(row),
        );
        return {
          id,
          updateCount: jsonNumber(row.update_count) ?? 0,
          previous: row,
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
      entries.filter((entry): entry is ProspectiveUpdate => entry !== null),
    ),
  );
}

function existingEvidence(row: JsonObject) {
  return {
    certainty: normalizeCertaintyValue(row.certainty),
    evidence: parseStoredEvidence(row.evidence),
  };
}

/** A create asserts its certainty; a strong-upsert update only when given. */
function assertAddEvidence(metadata: AddMetadata, existing?: JsonObject) {
  assertEvidenceWrite(
    {
      certainty:
        existing === undefined || metadata.explicit.certainty
          ? normalizeCertaintyValue(metadata.certainty)
          : undefined,
      evidence: metadata.evidence,
    },
    existing === undefined ? undefined : existingEvidence(existing),
  );
}

function resolveAddContent(
  args: string[],
  positionals: string[],
  fileSystem: CommandContext["fileSystem"],
): Effect.Effect<string, unknown> {
  const contentFromArg = positionals[0];
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
      evidence: parseEvidenceFlag(args),
      validationGaps: parseValidationGapsFlag(args),
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
  minScore: number = UPSERT_DEFAULT_MIN_SCORE,
): boolean {
  const matchedText = [
    stringValue(matched.content),
    stringValue(matched.tags),
    stringValue(matched.context),
  ].join(" ");
  const incomingText = upsertComparableText(content, metadata);
  const similarity = compareMemoryFact(matchedText, incomingText).similarity;
  const score = Number(matched.score ?? 0);
  return similarity >= UPSERT_MIN_SIMILARITY && score >= minScore;
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
        compareMemoryFact(matchedText, upsertComparableText(content, metadata))
          .similarity * 1000,
      ) / 1000,
    memory_type: stringValue(matched.memory_type, "convention"),
    status: stringValue(matched.status, "active"),
    // 120 characters plus the ellipsis.
    content_head: contentSnippet(matched.content, 121),
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
  return [
    ...specs.filter((spec): spec is UpdateSpec => spec !== undefined),
    ...evidenceUpdateSpecs(metadata.evidence, metadata.validationGaps),
  ];
}

/** Only flags that were given are written; [] explicitly clears. */
function evidenceUpdateSpecs(
  evidence: EvidenceKind[] | undefined,
  validationGaps: string[] | undefined,
): UpdateSpec[] {
  const specs: UpdateSpec[] = [];
  if (evidence !== undefined) {
    specs.push({ clause: "evidence = ?", value: JSON.stringify(evidence) });
  }
  if (validationGaps !== undefined) {
    specs.push({
      clause: "validation_gaps = ?",
      value: JSON.stringify(validationGaps),
    });
  }
  return specs;
}

function updateFromAddPayload(
  database: MemoryDatabaseApi,
  targetId: number,
  content: string,
  metadata: AddMetadata,
  updateCount: number,
): Effect.Effect<JsonValue | undefined, MemoryDatabaseError> {
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
  if (
    metadata.explicit.memoryType &&
    metadata.memoryType !== "status" &&
    !metadata.explicit.expiresAfterDays
  ) {
    sets.push("expires_after_days = NULL");
  }
  return database.get(
    `UPDATE memories SET ${sets.join(", ")} WHERE repository = ? AND id = ? AND status = 'active' AND COALESCE(update_count, 0) = ? RETURNING *`,
    [...params, repositoryForCurrentDirectory(), targetId, updateCount],
  );
}

function printUpsertResult(
  outputMode: CommandContext["outputMode"],
  mode: "created" | "updated",
  id: number,
  extras: {
    tokenReport?: BgeTokenBreakdown;
    matchInfo?: JsonObject;
    reconciliation?: JsonObject;
  } = {},
) {
  const { tokenReport, matchInfo, reconciliation = {} } = extras;
  const payload: JsonObject = matchInfo
    ? { mode, id, upsert_match: matchInfo, ...reconciliation }
    : { mode, id, ...reconciliation };
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
    assertAddEvidence(metadata, strong && matched ? matched : undefined);

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
    const canonical = yield* getMemoryById(database, matchedId);
    if (!canonical || canonical.status !== "active") {
      return yield* commandError(
        "add",
        `Memory ${matchedId} is no longer active; retry the match.`,
      );
    }
    const breakdown = yield* validateEmbeddingFit(
      "add",
      `Memory ${matchedId}`,
      memoryVectorEmbeddingParts(
        addUpsertEmbeddingDocument(canonical, content, metadata),
      ),
    );
    const updated = jsonObject(
      yield* updateFromAddPayload(
        database,
        matchedId,
        content,
        metadata,
        jsonNumber(canonical.update_count) ?? 0,
      ),
    );
    if (!updated) {
      return yield* commandError(
        "add",
        `Memory ${matchedId} changed concurrently; retry the match.`,
      );
    }
    const reconciliation = yield* reconcileWrite(database, canonical, content);
    yield* Effect.sync(() =>
      printUpsertResult(outputMode, "updated", matchedId, {
        tokenReport: params.tokenReportEnabled ? breakdown : undefined,
        reconciliation: reconciliationFields(
          reconciliation,
          hasMinimalOutput(outputMode),
        ),
      }),
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
    yield* Effect.sync(() =>
      printUpsertResult(outputMode, "created", createdId, {
        tokenReport: params.tokenReportEnabled ? breakdown : undefined,
        matchInfo: params.info ?? undefined,
      }),
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
      return yield* refusal();
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
  const columns = [
    "repository",
    "content",
    "tags",
    "context",
    "memory_type",
    "certainty",
    "status",
    "superseded_by",
    "source_agent",
    "last_updated_by",
    "update_count",
    "refs",
    "expires_after_days",
  ];
  const params: (string | number | null)[] = [
    repositoryForCurrentDirectory(),
    content,
    metadata.tags,
    metadata.memo,
    metadata.memoryType,
    metadata.certainty,
    "active",
    null,
    metadata.sourceAgent,
    metadata.updatedBy,
    0,
    JSON.stringify(metadata.refs),
    metadata.expiresAfterDays ?? null,
  ];
  // Omitted columns keep their '[]' default, so writes still work against a
  // remote database that has not applied the evidence migration yet.
  for (const [column, values] of [
    ["evidence", metadata.evidence],
    ["validation_gaps", metadata.validationGaps],
  ] as const) {
    if (values !== undefined && values.length > 0) {
      columns.push(column);
      params.push(JSON.stringify(values));
    }
  }
  return database.run(
    `INSERT INTO memories (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params,
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
    yield* assertWritableRepository(database, "add");
    const content = yield* resolveAddContent(
      args,
      commandCtx.positionals,
      commandCtx.fileSystem,
    );
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
    assertAddEvidence(metadata);
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
  positional: string[],
  database: MemoryDatabaseApi,
): Effect.Effect<UpdateTargets, MemoryDatabaseError> {
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
  specs.push(
    ...evidenceUpdateSpecs(
      parseEvidenceFlag(args),
      parseValidationGapsFlag(args),
    ),
  );
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
  const requestedType = requireMemoryType(args);
  if (
    requestedType !== undefined &&
    requestedType !== "status" &&
    !hasFlag(args, "--expires-after-days")
  ) {
    sets.push("expires_after_days = NULL");
  }
  return { sets, params };
}

function runBatchMemoryUpdate(
  database: MemoryDatabaseApi,
  targetIds: number[],
  update: { sets: string[]; params: (string | number | null)[] },
  snapshots: Map<number, number>,
  activeOnly: boolean,
): Effect.Effect<
  {
    rows: JsonObject[];
    missingIds: number[];
    conflictIds: number[];
    error?: string;
    unprocessed?: number[];
  },
  MemoryDatabaseError
> {
  return Effect.gen(function* () {
    const rows: JsonObject[] = [];
    const missingIds: number[] = [];
    const conflictIds: number[] = [];
    for (const [index, targetId] of targetIds.entries()) {
      if (!snapshots.has(targetId)) {
        missingIds.push(targetId);
        continue;
      }
      const outcome = yield* database
        .get(
          `UPDATE memories SET ${update.sets.join(", ")} WHERE repository = ? AND id = ? AND COALESCE(update_count, 0) = ?${activeOnly ? " AND status = 'active'" : ""} RETURNING *`,
          [
            ...update.params,
            repositoryForCurrentDirectory(),
            targetId,
            snapshots.get(targetId)!,
          ],
        )
        .pipe(
          Effect.match({
            onFailure: (cause) => ({ error: cause.message, row: undefined }),
            onSuccess: (row) => ({ error: undefined, row: jsonObject(row) }),
          }),
        );
      if (outcome.error) {
        return {
          rows,
          missingIds,
          conflictIds,
          error: outcome.error,
          unprocessed: targetIds.slice(index),
        };
      }
      if (outcome.row) {
        rows.push(normalizeSqliteRow(outcome.row));
      } else {
        conflictIds.push(targetId);
      }
    }
    return { rows, missingIds, conflictIds };
  });
}

function printMinimalUpdateResult(
  outputMode: CommandContext["outputMode"],
  id: number | undefined,
  breakdown: BgeTokenBreakdown | undefined,
  reconciliation: JsonObject,
): void {
  if (!outputMode.brief) {
    printJson({ id, ...reconciliation });
    return;
  }
  const compact: JsonObject = { id, status: "updated", ...reconciliation };
  if (breakdown) {
    Object.assign(compact, { tokens: breakdown });
  }
  printJson(compact);
}

function printSingleUpdateResult(params: {
  commandCtx: CommandContext;
  firstId: number | undefined;
  row: JsonObject | undefined;
  tokenReportEnabled: boolean;
  tokenBreakdowns: Map<number, BgeTokenBreakdown>;
  reconciliation?: Reconciliation;
}): void {
  const { commandCtx, firstId, row, tokenReportEnabled, tokenBreakdowns } =
    params;
  const minimalFields = reconciliationFields(params.reconciliation, true);
  const { outputMode } = commandCtx;
  if (!row) {
    printCommandOutput(commandCtx, {
      id: firstId,
      status: "not_found",
      not_found: [firstId],
      error: "Not found",
    });
    return;
  }
  if (hasMinimalOutput(outputMode)) {
    printMinimalUpdateResult(
      outputMode,
      firstId,
      firstId !== undefined ? tokenBreakdowns.get(firstId) : undefined,
      minimalFields,
    );
    return;
  }
  if (tokenReportEnabled && firstId !== undefined) {
    const breakdown = tokenBreakdowns.get(firstId);
    if (breakdown) {
      Object.assign(row, { tokens: breakdown });
    }
  }
  Object.assign(row, reconciliationFields(params.reconciliation, false));
  printCommandOutput(commandCtx, row);
}

function printUpdateResults(params: {
  commandCtx: CommandContext;
  targetIds: number[];
  rows: JsonObject[];
  missingIds: number[];
  tokenReportEnabled: boolean;
  tokenBreakdowns: Map<number, BgeTokenBreakdown>;
  reconciliations: Reconciliation[];
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
      reconciliation: params.reconciliations[0],
    });
    return;
  }
  const minimal = hasMinimalOutput(outputMode);
  const reconciliation = params.reconciliations
    .map((entry) => ({ id: entry.id, ...reconciliationFields(entry, minimal) }))
    .filter((entry) => Object.keys(entry).length > 1);
  if (minimal) {
    const compact: JsonObject = {
      updated_ids: rows.map((row) => Number(row.id)),
      not_found: missingIds,
      count: rows.length,
    };
    if (reconciliation.length > 0) {
      compact.reconciliation = reconciliation;
    }
    printJson(compact);
    return;
  }
  const payload: JsonObject = {
    updated: rows,
    not_found: missingIds,
    count: rows.length,
  };
  if (reconciliation.length > 0) {
    payload.reconciliation = reconciliation;
  }
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
  prospective: ProspectiveUpdate[],
): Effect.Effect<void, CommandError> {
  return Effect.gen(function* () {
    const targets: JsonObject[] = [];
    let anyOverBudget = false;
    for (const entry of prospective) {
      const size = yield* measureEmbeddingFit(
        memoryVectorEmbeddingParts(entry.document),
      );
      anyOverBudget = anyOverBudget || !size.within_limit;
      const target: JsonObject = {
        id: entry.id,
        size: embeddingSizeReport(size),
      };
      const dropped = droppedFor(entry.previous, entry.document.content);
      if (dropped) {
        target.dropped = dropped;
      }
      targets.push(target);
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
      commandCtx.positionals,
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
    const result = yield* runBatchMemoryUpdate(
      database,
      targetIds,
      { sets, params },
      new Map(prospective.map((entry) => [entry.id, entry.updateCount])),
      hasFlag(args, "--match"),
    );
    const { rows, missingIds } = result;
    const updatedIds = new Set(rows.map((row) => Number(row.id)));
    const reconciliations = yield* Effect.forEach(
      prospective.filter((entry) => updatedIds.has(entry.id)),
      (entry) => reconcileWrite(database, entry.previous, content),
    );
    yield* Effect.sync(() => {
      if (missingIds.length || result.conflictIds.length || result.error) {
        process.exitCode = 1;
      }
      if (result.error || result.conflictIds.length) {
        printCommandOutput(commandCtx, {
          updated_ids: rows.map((row) => Number(row.id)),
          not_found: missingIds,
          conflicts: result.conflictIds,
          count: rows.length,
          error: result.error ?? "Concurrent mutation; retry.",
          unprocessed: result.unprocessed ?? [],
        });
        return;
      }
      printUpdateResults({
        commandCtx,
        targetIds,
        rows,
        missingIds,
        tokenReportEnabled,
        tokenBreakdowns,
        reconciliations,
      });
    });
  });
}

function resolveDeprecateTargets(
  args: string[],
  positional: string[],
  database: MemoryDatabaseApi,
): Effect.Effect<number[], MemoryDatabaseError> {
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
  reviewCandidates: JsonObject[];
}): void {
  const { commandCtx, supersededByRequested, targetIds, rows, missingIds } =
    params;
  const review = reconciliationFields(
    { id: 0, reviewCandidates: params.reviewCandidates },
    hasMinimalOutput(commandCtx.outputMode),
  );
  const { outputMode } = commandCtx;
  if (targetIds.length === 1 && !rows.length) {
    printCommandOutput(commandCtx, {
      id: targetIds[0],
      status: "not_found",
      not_found: missingIds,
      error: "Not found",
    });
    return;
  }
  if (hasMinimalOutput(outputMode)) {
    if (targetIds.length === 1) {
      const firstId = targetIds[0];
      if (outputMode.brief) {
        printJson({
          id: firstId,
          status: supersededByRequested ? "superseded_by" : "deprecated",
          ...review,
        });
      } else {
        printJson({ id: firstId, ...review });
      }
    } else {
      printJson({
        deprecated_ids: rows.map((row) => Number(row.id)),
        not_found: missingIds,
        count: rows.length,
        ...review,
      });
    }
    return;
  }
  if (targetIds.length === 1) {
    printCommandOutput(
      commandCtx,
      rows[0] ? { ...rows[0], ...review } : { error: "Not found" },
    );
    return;
  }
  printCommandOutput(commandCtx, {
    deprecated: rows,
    not_found: missingIds,
    count: rows.length,
    ...review,
  });
}

export function handleDeprecateCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args } = commandCtx;
    const database = requireDatabase(commandCtx);
    const targetIds = yield* resolveDeprecateTargets(
      args,
      commandCtx.positionals,
      database,
    );
    const { sets, params } = deprecateSetsAndParams(args, targetIds);
    const supersededBy = parseIntegerFlag(args, "--superseded-by");
    if (
      supersededBy !== undefined &&
      (supersededBy === null ||
        supersededBy <= 0 ||
        !(yield* getMemoryById(database, supersededBy)))
    ) {
      return yield* commandError(
        "deprecate",
        "--superseded-by must name an existing memory in this repository.",
      );
    }
    const snapshots = new Map<number, number>();
    for (const id of targetIds) {
      const row = yield* getMemoryById(database, id);
      if (row) {
        snapshots.set(id, jsonNumber(row.update_count) ?? 0);
      }
    }
    const result = yield* runBatchMemoryUpdate(
      database,
      targetIds,
      { sets, params },
      snapshots,
      hasFlag(args, "--match"),
    );
    const { rows, missingIds } = result;
    const reviewCandidates = yield* findReviewCandidates(
      database,
      rows,
      supersededBy === undefined || supersededBy === null ? [] : [supersededBy],
    );
    yield* Effect.sync(() => {
      if (missingIds.length || result.conflictIds.length || result.error) {
        process.exitCode = 1;
      }
      if (result.error || result.conflictIds.length) {
        printCommandOutput(commandCtx, {
          deprecated_ids: rows.map((row) => Number(row.id)),
          not_found: missingIds,
          conflicts: result.conflictIds,
          count: rows.length,
          error: result.error ?? "Concurrent mutation; retry.",
          unprocessed: result.unprocessed ?? [],
        });
        return;
      }
      printDeprecateResults({
        commandCtx,
        supersededByRequested: hasFlag(args, "--superseded-by"),
        targetIds,
        rows,
        missingIds,
        reviewCandidates,
      });
    });
  });
}

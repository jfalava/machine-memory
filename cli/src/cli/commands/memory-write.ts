import { createInterface } from "node:readline/promises";

import {
  canonicalTags,
  decideUpsert,
  droppedDetails,
  embeddingBudgetMessage,
  embeddingSizeReport,
  type EmbeddingDocumentParts,
  type EmbeddingSizeReport,
  hasDroppedDetails,
  memoryContentError,
  type EvidenceKind,
  type UpsertDecision,
  compareMemoryFact,
  UPSERT_DEFAULT_MIN_SCORE,
  UPSERT_MIN_SIMILARITY,
} from "@machine-memory/contract";
import { Effect } from "effect";

import {
  type CommandFlags,
  getFlagValue,
  hasFlag,
  printJson,
  usageError,
  warnOnStderr,
} from "../../cli-utils";
import type {
  MemoryDatabaseApi,
  MemoryDatabaseError,
} from "../../effect/database";
import { commandError, type CommandError } from "../../effect/errors";
import type { MemoryVectorDocument } from "../../effect/vectorize";
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
  flags: CommandFlags,
): Effect.Effect<number, CommandError> {
  const raw = getFlagValue(flags, "--upsert-threshold");
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

/** Tells stderr what a write lost, since stdout may be piped through a filter. */
function warnReconciliation(
  subject: string,
  reconciliation: Reconciliation | undefined,
): void {
  const findings: string[] = [];
  const count = (value: JsonValue | undefined) =>
    Array.isArray(value) ? value.length : 0;
  const identifiers = count(reconciliation?.dropped?.identifiers);
  const sentences = count(reconciliation?.dropped?.sentences);
  if (identifiers > 0 || sentences > 0) {
    findings.push(
      `dropped ${identifiers} identifier(s) and ${sentences} sentence(s) of the old content`,
    );
  }
  const candidates = reconciliation?.reviewCandidates ?? [];
  if (candidates.length > 0) {
    findings.push(
      `${candidates.length} record(s) may rely on the old content: ${candidates.map((row) => `#${Number(row.id)}`).join(", ")}`,
    );
  }
  if (findings.length > 0) {
    warnOnStderr(
      `${subject} ${findings.join("; ")}. See dropped and review_candidates in the output.`,
    );
  }
}

/** The size report of the embedded text a write would produce, or the refusal. */
function validateEmbeddingFit(
  command: string,
  label: string,
  document: EmbeddingDocumentParts,
): Effect.Effect<EmbeddingSizeReport, CommandError> {
  const size = embeddingSizeReport(document);
  return size.within_budget
    ? Effect.succeed(size)
    : Effect.fail(
        commandError(
          command,
          `${embeddingBudgetMessage(label, size)} Nothing was written.`,
        ),
      );
}

/** Used and remaining bytes, reported by every successful write. */
function sizeSummary(size: EmbeddingSizeReport): JsonObject {
  return { bytes: size.bytes, remaining_bytes: size.remaining_bytes };
}

function addEmbeddingDocumentParts(
  content: string,
  metadata: AddMetadata,
): EmbeddingDocumentParts {
  return { content, tags: metadata.tags, context: metadata.memo };
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
  flags: CommandFlags,
  database: MemoryDatabaseApi,
  targetIds: number[],
  content: string,
): Effect.Effect<ProspectiveUpdate[], MemoryDatabaseError> {
  const overrides = {
    tags: optionalCanonicalTags(getFlagValue(flags, "--tags")),
    context: getFlagValue(flags, "--context"),
    memory_type: requireMemoryType(flags),
    certainty: requireCertainty(flags),
  };
  const evidence = parseEvidenceFlag(flags);
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

/** Content that is present and not a coerced missing value. */
function requireMemoryContent(
  content: string | undefined,
  usage: string,
): string {
  if (!content) {
    usageError(`Usage: ${usage}`);
  }
  const invalid = memoryContentError(content);
  if (invalid !== undefined) {
    usageError(`${invalid} Nothing was written.`);
  }
  return content;
}

function resolveAddContent(
  flags: CommandFlags,
  positionals: string[],
  fileSystem: CommandContext["fileSystem"],
): Effect.Effect<string, unknown> {
  const contentFromArg = positionals[0];
  return parseContentFromFileFlag(flags, fileSystem).pipe(
    Effect.map((contentFromFile) => {
      if (contentFromArg && contentFromFile !== undefined) {
        usageError(`Usage: ${ADD_USAGE}`);
      }
      return requireMemoryContent(contentFromFile ?? contentFromArg, ADD_USAGE);
    }),
  );
}

function resolveAddMetadata(
  flags: CommandFlags,
  fileSystem: CommandContext["fileSystem"],
): Effect.Effect<AddMetadata, unknown> {
  const explicitTags = getFlagValue(flags, "--tags");
  const pathContext = getFlagValue(flags, "--path");
  const sourceAgent = getFlagValue(flags, "--source-agent") ?? "";
  const explicitFlags: AddExplicitFlags = {
    tags: explicitTags !== undefined,
    context: getFlagValue(flags, "--context") !== undefined,
    memoryType: getFlagValue(flags, "--type") !== undefined,
    certainty: getFlagValue(flags, "--certainty") !== undefined,
    sourceAgent: getFlagValue(flags, "--source-agent") !== undefined,
    updatedBy: getFlagValue(flags, "--updated-by") !== undefined,
    refs: getFlagValue(flags, "--refs") !== undefined,
    expiresAfterDays: getFlagValue(flags, "--expires-after-days") !== undefined,
  };
  return (
    pathContext
      ? suggestTagsForPath(fileSystem, pathContext)
      : Effect.succeed([])
  ).pipe(
    Effect.map((mappedTags) => ({
      mappedTags,
      tags: mergeTagValues(explicitTags, mappedTags),
      memo: getFlagValue(flags, "--context") ?? "",
      memoryType: requireMemoryType(flags) ?? "convention",
      certainty: requireCertainty(flags) ?? "inferred",
      sourceAgent,
      updatedBy: getFlagValue(flags, "--updated-by") ?? sourceAgent,
      refs: parseRefsFlag(flags) ?? [],
      evidence: parseEvidenceFlag(flags),
      validationGaps: parseValidationGapsFlag(flags),
      expiresAfterDays: parseIntegerFlag(flags, "--expires-after-days"),
      explicit: explicitFlags,
    })),
  );
}

function parseAddUpsertQuery(flags: CommandFlags): string | undefined {
  const value = getFlagValue(flags, "--upsert-match");
  if (hasFlag(flags, "--upsert-match") && value === undefined) {
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

/** FTS score and unrounded similarity of the best match; decideUpsert reads both. */
type UpsertMatchScores = { score: number; similarity: number };

function upsertMatchScores(
  matched: JsonObject,
  content: string,
  metadata: AddMetadata,
): UpsertMatchScores {
  const matchedText = [
    stringValue(matched.content),
    stringValue(matched.tags),
    stringValue(matched.context),
  ].join(" ");
  return {
    score: Number(matched.score ?? 0),
    similarity: compareMemoryFact(
      matchedText,
      upsertComparableText(content, metadata),
    ).similarity,
  };
}

function upsertMatchInfo(
  matched: JsonObject,
  scores: UpsertMatchScores,
): JsonObject {
  return {
    id: Number(matched.id ?? 0),
    score: scores.score,
    similarity: Math.round(scores.similarity * 1000) / 1000,
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
    sizeReport?: EmbeddingSizeReport;
    matchInfo?: JsonObject;
    reconciliation?: JsonObject;
  } = {},
) {
  const { sizeReport, matchInfo, reconciliation = {} } = extras;
  const payload: JsonObject = matchInfo
    ? { mode, id, upsert_match: matchInfo, ...reconciliation }
    : { mode, id, ...reconciliation };
  if (sizeReport) {
    Object.assign(payload, { size: sizeSummary(sizeReport) });
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
    flags: CommandFlags;
    content: string;
    metadata: AddMetadata;
    outputMode: CommandContext["outputMode"];
  },
) {
  const { flags, content, metadata, outputMode } = options;
  const upsertQuery = parseAddUpsertQuery(flags);
  if (upsertQuery === undefined) {
    return Effect.succeed(false);
  }
  return Effect.gen(function* () {
    const minScore = yield* resolveUpsertMinScore(flags);
    const matched = yield* findMemoryByMatch(database, upsertQuery);
    const scores =
      matched === null
        ? undefined
        : upsertMatchScores(matched, content, metadata);
    const decision = decideUpsert({
      match: scores,
      minScore,
      force: hasFlag(flags, "--force"),
    });
    const info = matched && scores ? upsertMatchInfo(matched, scores) : null;
    const summary = info ? summarizeUpsertMatch(info) : null;
    assertAddEvidence(
      metadata,
      decision === "update" && matched ? matched : undefined,
    );

    if (hasFlag(flags, "--dry-run")) {
      return yield* runAddUpsertDryRun({
        content,
        metadata,
        outputMode,
        matched,
        decision,
        info,
        summary,
        minScore,
      });
    }

    if (decision === "refuse" && summary) {
      yield* enforceWeakMatchGate(summary, minScore);
    }

    if (decision === "update" && matched) {
      return yield* runStrongUpsertUpdate({
        database,
        matched,
        content,
        metadata,
        outputMode,
      });
    }
    return yield* runUpsertCreate({
      database,
      content,
      metadata,
      outputMode,
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
      addUpsertEmbeddingDocument(canonical, content, metadata),
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
    yield* Effect.sync(() => {
      warnReconciliation(`Upsert into memory ${matchedId}`, reconciliation);
      printUpsertResult(outputMode, "updated", matchedId, {
        sizeReport: breakdown,
        reconciliation: reconciliationFields(
          reconciliation,
          hasMinimalOutput(outputMode),
        ),
      });
    });
    return true;
  });
}

function runUpsertCreate(params: {
  database: MemoryDatabaseApi;
  content: string;
  metadata: AddMetadata;
  outputMode: CommandContext["outputMode"];
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
        sizeReport: breakdown,
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
  decision: UpsertDecision;
  info: JsonObject | null;
  summary: UpsertMatchSummary | null;
  minScore: number;
};

function addUpsertDryRunPayload(
  params: AddUpsertDryRunParams,
  size: EmbeddingSizeReport,
): JsonObject {
  const { decision, info, summary, minScore } = params;
  const payload: JsonObject = {
    command: "add",
    dry_run: true,
    action: decision,
  };
  if (info) {
    Object.assign(payload, { would_match: info });
  }
  if (decision !== "update" && summary) {
    Object.assign(payload, {
      note: `Best match #${summary.id} is not a strong upsert match (score ${summary.score}, similarity ${summary.similarity}; needs score >= ${minScore} AND similarity >= ${UPSERT_MIN_SIMILARITY}); ${
        decision === "refuse"
          ? `this write is refused. Update #${summary.id} by id, pass --force to create a new record, or lower --upsert-threshold.`
          : `--force creates a NEW record instead of updating #${summary.id}.`
      }`,
    });
  }
  Object.assign(payload, { size });
  return payload;
}

function runAddUpsertDryRun(
  params: AddUpsertDryRunParams,
): Effect.Effect<boolean, MemoryDatabaseError | CommandError> {
  return Effect.gen(function* () {
    const prospectiveParts =
      params.decision === "update" && params.matched
        ? addUpsertEmbeddingDocument(
            params.matched,
            params.content,
            params.metadata,
          )
        : addEmbeddingDocumentParts(params.content, params.metadata);
    const size = embeddingSizeReport(prospectiveParts);
    yield* Effect.sync(() => {
      printCommandOutput(
        { command: "add", outputMode: params.outputMode },
        addUpsertDryRunPayload(params, size),
      );
      // A dry run exits the way the real write would.
      if (!size.within_budget || params.decision === "refuse") {
        process.exitCode = 1;
      }
    });
    return true;
  });
}

/** A refused weak match fails, or asks for confirmation on a terminal. */
function enforceWeakMatchGate(
  summary: UpsertMatchSummary,
  minScore: number,
): Effect.Effect<void, CommandError> {
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

function attachSizeSummary(
  payload: JsonObject,
  sizeReport: EmbeddingSizeReport | undefined,
): void {
  if (sizeReport) {
    Object.assign(payload, { size: sizeSummary(sizeReport) });
  }
}

function briefAddPayload(params: {
  createdId: number;
  conflictCount: number;
  statusCascadeCount: number;
  sizeReport?: EmbeddingSizeReport;
}): JsonObject {
  const payload: JsonObject = {
    id: params.createdId,
    status: "created",
    conflict_count: params.conflictCount,
    status_cascade_count: params.statusCascadeCount,
  };
  attachSizeSummary(payload, params.sizeReport);
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
  sizeReport?: EmbeddingSizeReport;
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
    sizeReport,
  } = params;
  if (outputMode.jsonMin || outputMode.quiet) {
    printJson(
      sizeReport
        ? { id: createdId, size: sizeSummary(sizeReport) }
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
        sizeReport,
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
  if (sizeReport) {
    attachSizeSummary(payload, sizeReport);
  }
  printCommandOutput({ command: "add", outputMode }, payload);
}

function runAddDryRun(
  commandCtx: CommandContext,
  content: string,
  metadata: AddMetadata,
): Effect.Effect<void, CommandError> {
  return Effect.gen(function* () {
    const size = embeddingSizeReport(
      addEmbeddingDocumentParts(content, metadata),
    );
    yield* Effect.sync(() => {
      printCommandOutput(
        { command: "add", outputMode: commandCtx.outputMode },
        {
          command: "add",
          dry_run: true,
          action: "create",
          size,
        } satisfies JsonObject,
      );
      if (!size.within_budget) {
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
  sizeReport: EmbeddingSizeReport | undefined;
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
        sizeReport: params.sizeReport,
      }),
    );
  });
}

export function handleAddCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { flags, outputMode } = commandCtx;
    const database = requireDatabase(commandCtx);
    yield* assertWritableRepository(database, "add");
    const content = yield* resolveAddContent(
      flags,
      commandCtx.positionals,
      commandCtx.fileSystem,
    );
    const metadata = yield* resolveAddMetadata(flags, commandCtx.fileSystem);
    if (
      yield* maybeHandleAddUpsert(database, {
        flags,
        content,
        metadata,
        outputMode,
      })
    ) {
      return;
    }
    assertAddEvidence(metadata);
    if (hasFlag(flags, "--dry-run")) {
      yield* runAddDryRun(commandCtx, content, metadata);
      return;
    }
    const embeddingBreakdown = yield* validateEmbeddingFit(
      "add",
      "Memory",
      addEmbeddingDocumentParts(content, metadata),
    );
    const sizeReport = embeddingBreakdown;
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
      sizeReport,
      conflictState,
    });
  });
}

function resolveUpdateTargets(
  flags: CommandFlags,
  positional: string[],
  database: MemoryDatabaseApi,
): Effect.Effect<UpdateTargets, MemoryDatabaseError> {
  const matchQuery = getFlagValue(flags, "--match");

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
  flags: CommandFlags,
  contentFromArg: string | undefined,
  fileSystem: CommandContext["fileSystem"],
): Effect.Effect<string, unknown> {
  return parseContentFromFileFlag(flags, fileSystem).pipe(
    Effect.map((contentFromFile) => {
      if (contentFromArg && contentFromFile !== undefined) {
        usageError(`Usage: ${UPDATE_USAGE}`);
      }
      return requireMemoryContent(
        contentFromFile ?? contentFromArg,
        UPDATE_USAGE,
      );
    }),
  );
}

function optionalCanonicalTags(value: string | undefined) {
  return value === undefined ? undefined : canonicalTags(value);
}

function optionalUpdateSpecs(flags: CommandFlags): UpdateSpec[] {
  const specs: UpdateSpec[] = [];
  const maybeSpecs: (UpdateSpec | undefined)[] = [
    (() => {
      const value = optionalCanonicalTags(getFlagValue(flags, "--tags"));
      return value === undefined ? undefined : { clause: "tags = ?", value };
    })(),
    (() => {
      const value = getFlagValue(flags, "--context");
      return value === undefined ? undefined : { clause: "context = ?", value };
    })(),
    (() => {
      const value = requireMemoryType(flags);
      return value === undefined
        ? undefined
        : { clause: "memory_type = ?", value };
    })(),
    (() => {
      const value = requireCertainty(flags);
      return value === undefined
        ? undefined
        : { clause: "certainty = ?", value };
    })(),
    (() => {
      const value = getFlagValue(flags, "--updated-by");
      return value === undefined
        ? undefined
        : { clause: "last_updated_by = ?", value };
    })(),
    (() => {
      const value = parseRefsFlag(flags);
      return value === undefined
        ? undefined
        : { clause: "refs = ?", value: JSON.stringify(value) };
    })(),

    (() => {
      const value = parseIntegerFlag(flags, "--expires-after-days", {
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
      parseEvidenceFlag(flags),
      parseValidationGapsFlag(flags),
    ),
  );
  return specs;
}

function updateSetsAndParams(flags: CommandFlags, content: string) {
  const sets = [
    "content = ?",
    "updated_at = datetime('now')",
    "update_count = COALESCE(update_count, 0) + 1",
  ];
  const params: (string | number | null)[] = [content];
  for (const spec of optionalUpdateSpecs(flags)) {
    sets.push(spec.clause);
    params.push(spec.value);
  }
  const requestedType = requireMemoryType(flags);
  if (
    requestedType !== undefined &&
    requestedType !== "status" &&
    !hasFlag(flags, "--expires-after-days")
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
  breakdown: EmbeddingSizeReport | undefined,
  reconciliation: JsonObject,
): void {
  const compact: JsonObject = outputMode.brief
    ? { id, status: "updated", ...reconciliation }
    : { id, ...reconciliation };
  attachSizeSummary(compact, breakdown);
  printJson(compact);
}

function printSingleUpdateResult(params: {
  commandCtx: CommandContext;
  firstId: number | undefined;
  row: JsonObject | undefined;
  sizeReports: Map<number, EmbeddingSizeReport>;
  reconciliation?: Reconciliation;
}): void {
  const { commandCtx, firstId, row, sizeReports } = params;
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
      firstId !== undefined ? sizeReports.get(firstId) : undefined,
      minimalFields,
    );
    return;
  }
  attachSizeSummary(
    row,
    firstId !== undefined ? sizeReports.get(firstId) : undefined,
  );
  Object.assign(row, reconciliationFields(params.reconciliation, false));
  printCommandOutput(commandCtx, row);
}

function printUpdateResults(params: {
  commandCtx: CommandContext;
  targetIds: number[];
  rows: JsonObject[];
  missingIds: number[];
  sizeReports: Map<number, EmbeddingSizeReport>;
  reconciliations: Reconciliation[];
}): void {
  const { commandCtx, targetIds, rows, missingIds, sizeReports } = params;
  const { outputMode } = commandCtx;
  if (targetIds.length === 1) {
    printSingleUpdateResult({
      commandCtx,
      firstId: targetIds[0],
      row: rows[0],
      sizeReports,
      reconciliation: params.reconciliations[0],
    });
    return;
  }
  const minimal = hasMinimalOutput(outputMode);
  const reconciliation = params.reconciliations
    .map((entry) => ({ id: entry.id, ...reconciliationFields(entry, minimal) }))
    .filter((entry) => Object.keys(entry).length > 1);
  const payload: JsonObject = minimal
    ? { updated_ids: rows.map((row) => Number(row.id)) }
    : { updated: rows };
  Object.assign(payload, { not_found: missingIds, count: rows.length });
  if (reconciliation.length > 0) {
    payload.reconciliation = reconciliation;
  }
  if (sizeReports.size > 0) {
    payload.sizes = [...sizeReports.entries()].map(([id, size]) => ({
      id,
      ...sizeSummary(size),
    }));
  }
  if (minimal) {
    printJson(payload);
    return;
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
      const size = embeddingSizeReport(entry.document);
      anyOverBudget = anyOverBudget || !size.within_budget;
      const target: JsonObject = {
        id: entry.id,
        size,
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
): Effect.Effect<Map<number, EmbeddingSizeReport>, CommandError> {
  return Effect.gen(function* () {
    const sizeReports = new Map<number, EmbeddingSizeReport>();
    for (const entry of prospective) {
      const breakdown = yield* validateEmbeddingFit(
        "update",
        `Memory ${entry.id}`,
        entry.document,
      );
      sizeReports.set(entry.id, breakdown);
    }
    return sizeReports;
  });
}

/** One content belongs to one record; the same text on several ids erases them. */
function assertSingleContentTarget(targetIds: number[]): void {
  if (targetIds.length === 0) {
    usageError(`Usage: ${UPDATE_USAGE}`);
  }
  if (targetIds.length > 1) {
    usageError(
      `update replaces the content of one memory, and ${targetIds.length} ids were given (${targetIds.join(", ")}). Update each memory with its own content. Nothing was written.`,
    );
  }
}

/** --expected-update-count pins the update to the read it was based on. */
function assertExpectedUpdateCount(
  flags: CommandFlags,
  prospective: ProspectiveUpdate[],
): Effect.Effect<void, CommandError> {
  const expected = parseIntegerFlag(flags, "--expected-update-count");
  if (expected === undefined) {
    return Effect.void;
  }
  if (expected === null || expected < 0) {
    usageError("--expected-update-count must be a non-negative integer.");
  }
  const stale = prospective.find((entry) => entry.updateCount !== expected);
  return stale === undefined
    ? Effect.void
    : Effect.fail(
        commandError(
          "update",
          `Memory ${stale.id} has update_count ${stale.updateCount}, not the expected ${expected}; read it again before updating. Nothing was written.`,
        ),
      );
}

export function handleUpdateCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { flags } = commandCtx;
    const database = requireDatabase(commandCtx);
    const { targetIds, contentFromArg } = yield* resolveUpdateTargets(
      flags,
      commandCtx.positionals,
      database,
    );
    const content = yield* resolveUpdateContent(
      flags,
      contentFromArg,
      commandCtx.fileSystem,
    );
    assertSingleContentTarget(targetIds);
    const prospective = yield* prospectiveUpdateDocuments(
      flags,
      database,
      targetIds,
      content,
    );
    yield* assertExpectedUpdateCount(flags, prospective);
    if (hasFlag(flags, "--dry-run")) {
      yield* runUpdateDryRun(commandCtx, prospective);
      return;
    }
    const sizeReports = yield* validateProspectiveUpdates(prospective);
    const { sets, params } = updateSetsAndParams(flags, content);
    const result = yield* runBatchMemoryUpdate(
      database,
      targetIds,
      { sets, params },
      new Map(prospective.map((entry) => [entry.id, entry.updateCount])),
      hasFlag(flags, "--match"),
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
      for (const reconciliation of reconciliations) {
        warnReconciliation(
          `Update of memory ${reconciliation.id}`,
          reconciliation,
        );
      }
      printUpdateResults({
        commandCtx,
        targetIds,
        rows,
        missingIds,
        sizeReports,
        reconciliations,
      });
    });
  });
}

function resolveDeprecateTargets(
  flags: CommandFlags,
  positional: string[],
  database: MemoryDatabaseApi,
): Effect.Effect<number[], MemoryDatabaseError> {
  const matchQuery = getFlagValue(flags, "--match");

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

function deprecateSetsAndParams(flags: CommandFlags, targetIds: number[]) {
  const supersededBy = parseIntegerFlag(flags, "--superseded-by");
  if (
    supersededBy !== undefined &&
    targetIds.some((targetId) => supersededBy === targetId)
  ) {
    usageError("A memory cannot supersede itself.");
  }
  const updatedBy = getFlagValue(flags, "--updated-by");
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
  warnReconciliation(
    `Deprecating ${rows.map((row) => `#${Number(row.id)}`).join(", ")}:`,
    { id: 0, reviewCandidates: params.reviewCandidates },
  );
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
    const { flags } = commandCtx;
    const database = requireDatabase(commandCtx);
    const targetIds = yield* resolveDeprecateTargets(
      flags,
      commandCtx.positionals,
      database,
    );
    const { sets, params } = deprecateSetsAndParams(flags, targetIds);
    const supersededBy = parseIntegerFlag(flags, "--superseded-by");
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
      hasFlag(flags, "--match"),
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
        supersededByRequested: hasFlag(flags, "--superseded-by"),
        targetIds,
        rows,
        missingIds,
        reviewCandidates,
      });
    });
  });
}

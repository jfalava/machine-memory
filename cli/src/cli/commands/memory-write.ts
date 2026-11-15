import {
  assessReplacement,
  canonicalTags,
  changedText,
  compareMemoryFact,
  decideUpsert,
  droppedDetails,
  droppedNames,
  duplicateRefusal,
  editTags,
  editValidationGaps,
  embeddingBudgetMessage,
  embeddingSizeReport,
  hasDroppedDetails,
  memoryContentError,
  nameHoldersFromRows,
  nameHoldersQuery,
  nearDuplicate,
  sharedIdentifiers,
  upsertRefusal,
  UPSERT_DEFAULT_MIN_SCORE,
  type AddIntentHints,
  type DuplicateMatch,
  type EmbeddingDocumentParts,
  type EmbeddingSizeReport,
  type EvidenceKind,
  type ReplacementAssessment,
  type UpsertDecision,
} from "@machine-memory/contract";
import { Effect } from "effect";

import { currentWriter } from "../../attribution";
import { appendCandidate } from "../../candidates";
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
import { toContractValue } from "../../effect/remote-http";
import {
  jsonNumber,
  jsonObject,
  type JsonObject,
  type JsonValue,
} from "../../json";
import {
  suggestTagsForPath,
  type PathTagMatch,
  type PathTagSuggestion,
} from "../../path-tags";
import { repositoryForCurrentDirectory } from "../../repository";
import {
  assertEvidenceWrite,
  parseEvidenceFlag,
  parseGapListFlag,
  parseStoredEvidence,
  parseStoredValidationGaps,
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
  findMemoryMatches,
  findReviewCandidates,
  findStatusCascadeCandidates,
  getMemoryById,
  hasMinimalOutput,
  isMemoryType,
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
  refs: boolean;
  expiresAfterDays: boolean;
};

type AddMetadata = {
  mappedTags: string[];
  /** Which tag-map prefix matched each --path, and the paths none matched. */
  pathMatches: PathTagMatch[];
  unmatchedPaths: string[];
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

/** The stored fields one update replaces; undefined keeps the stored value. */
type RowChanges = {
  content: string | undefined;
  tags: string | undefined;
  context: string | undefined;
  validationGaps: string[] | undefined;
};

type ProspectiveUpdate = {
  id: number;
  updateCount: number;
  previous: JsonObject;
  changes: RowChanges;
  /** The embedded fields as the update would leave them. */
  document: EmbeddingDocumentParts;
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
  // Records can only come to rely on what the update removes or rewrites.
  return findReviewCandidates(database, [
    {
      id,
      memoryType: stringValue(previous.memory_type, "convention"),
      text: changedText(stringValue(previous.content), content),
    },
  ]).pipe(
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
      fields.review_candidates = reconciliation.reviewCandidates.map((row) => ({
        ...minimalResultSummary(row),
        shared_identifiers: row.shared_identifiers ?? [],
        cites: row.cites === true,
      }));
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
      `${subject}: ${findings.join("; ")}. See dropped and review_candidates in the output.`,
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

/** The embedded fields of a stored memory after an add replaces its content. */
function addUpsertEmbeddingDocument(
  target: JsonObject,
  content: string,
  metadata: AddMetadata,
): EmbeddingDocumentParts {
  return {
    content,
    tags:
      metadata.explicit.tags || metadata.mappedTags.length > 0
        ? metadata.tags
        : stringValue(target.tags),
    context: metadata.explicit.context
      ? metadata.memo
      : stringValue(target.context),
  };
}

/**
 * Whether new content may replace the stored content of a memory: refused when
 * it drops a name no other active record carries, or shares almost nothing
 * with what it replaces.
 */
function assessContentReplacement(
  database: MemoryDatabaseApi,
  previous: JsonObject,
  next: string,
  allowDrop: boolean,
): Effect.Effect<ReplacementAssessment, MemoryDatabaseError> {
  const id = Number(previous.id);
  const stored = stringValue(previous.content);
  const names = droppedNames(stored, next);
  const query = nameHoldersQuery({
    repository: repositoryForCurrentDirectory(),
    excludeId: id,
    names,
  });
  const memoryType = stringValue(previous.memory_type, "convention");
  return (
    names.length === 0
      ? Effect.succeed<JsonValue[]>([])
      : database.all(query.sql, query.params)
  ).pipe(
    Effect.map((rows) =>
      assessReplacement({
        id,
        previous: stored,
        next,
        memoryType: isMemoryType(memoryType) ? memoryType : "convention",
        holders: nameHoldersFromRows(rows.map(toContractValue)),
        allowDrop,
        allowDropHint: "--allow-drop",
      }),
    ),
  );
}

/** What a dry run reports about a replacement; the refusal text goes in `note`. */
function replacementSummary(assessment: ReplacementAssessment): JsonObject {
  return {
    action: assessment.action,
    text_overlap: assessment.text_overlap,
    orphaned_identifiers: assessment.orphaned_identifiers,
    held_elsewhere: assessment.held_elsewhere,
  };
}

/** The flags that change a field; any of them lets update run without content. */
const UPDATE_FIELD_FLAGS = [
  "--tags",
  "--add-tags",
  "--remove-tags",
  "--context",
  "--clear-context",
  "--type",
  "--certainty",
  "--evidence",
  "--validation-gaps",
  "--add-gap",
  "--remove-gap",
  "--updated-by",
  "--refs",
  "--expires-after-days",
];

/** Field changes as given on the command line, before they meet a stored row. */
type UpdateEdits = {
  tags: string | undefined;
  addTags: string | undefined;
  removeTags: string | undefined;
  context: string | undefined;
  validationGaps: string[] | undefined;
  addGaps: string[] | undefined;
  removeGaps: string[] | undefined;
};

function refuseTogether(
  flags: CommandFlags,
  whole: string,
  partial: string[],
): void {
  if (hasFlag(flags, whole) && partial.some((flag) => hasFlag(flags, flag))) {
    usageError(
      `${whole} replaces the stored value, so it cannot be combined with ${partial.join(" or ")}.`,
    );
  }
}

function resolveUpdateEdits(flags: CommandFlags): UpdateEdits {
  refuseTogether(flags, "--tags", ["--add-tags", "--remove-tags"]);
  refuseTogether(flags, "--context", ["--clear-context"]);
  refuseTogether(flags, "--validation-gaps", ["--add-gap", "--remove-gap"]);
  return {
    tags: optionalCanonicalTags(getFlagValue(flags, "--tags")),
    addTags: getFlagValue(flags, "--add-tags"),
    removeTags: getFlagValue(flags, "--remove-tags"),
    context: hasFlag(flags, "--clear-context")
      ? ""
      : getFlagValue(flags, "--context"),
    validationGaps: parseValidationGapsFlag(flags),
    addGaps: parseGapListFlag(flags, "--add-gap"),
    removeGaps: parseGapListFlag(flags, "--remove-gap"),
  };
}

/** Applies add and remove edits to one stored row, giving whole replacement values. */
function rowChanges(
  row: JsonObject,
  edits: UpdateEdits,
  content: string | undefined,
): Effect.Effect<RowChanges, CommandError> {
  const editsTags =
    edits.addTags !== undefined || edits.removeTags !== undefined;
  const gaps =
    edits.addGaps !== undefined || edits.removeGaps !== undefined
      ? editValidationGaps(parseStoredValidationGaps(row.validation_gaps), {
          add: edits.addGaps,
          remove: edits.removeGaps,
        })
      : undefined;
  if (gaps?.error !== undefined) {
    return Effect.fail(
      commandError(
        "update",
        `Memory ${Number(row.id)}: ${gaps.error} Nothing was written.`,
      ),
    );
  }
  return Effect.succeed({
    content,
    tags: editsTags
      ? editTags(stringValue(row.tags), {
          add: edits.addTags,
          remove: edits.removeTags,
        })
      : edits.tags,
    context: edits.context,
    validationGaps: gaps?.gaps ?? edits.validationGaps,
  });
}

function prospectiveUpdates(
  flags: CommandFlags,
  database: MemoryDatabaseApi,
  targetIds: number[],
  content: string | undefined,
): Effect.Effect<ProspectiveUpdate[], MemoryDatabaseError | CommandError> {
  const edits = resolveUpdateEdits(flags);
  const certainty = requireCertainty(flags);
  const evidence = parseEvidenceFlag(flags);
  return Effect.forEach(targetIds, (id) =>
    Effect.gen(function* () {
      const row = yield* getMemoryById(database, id);
      if (!row) {
        return null;
      }
      assertEvidenceWrite({ certainty, evidence }, existingEvidence(row));
      const changes = yield* rowChanges(row, edits, content);
      return {
        id,
        updateCount: jsonNumber(row.update_count) ?? 0,
        previous: row,
        changes,
        document: {
          content: changes.content ?? stringValue(row.content),
          tags: changes.tags ?? stringValue(row.tags),
          context: changes.context ?? stringValue(row.context),
        },
      } satisfies ProspectiveUpdate;
    }),
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
  const sourceAgent = getFlagValue(flags, "--source-agent") ?? currentWriter();
  const explicitFlags: AddExplicitFlags = {
    tags: explicitTags !== undefined,
    context: getFlagValue(flags, "--context") !== undefined,
    memoryType: getFlagValue(flags, "--type") !== undefined,
    certainty: getFlagValue(flags, "--certainty") !== undefined,
    sourceAgent: getFlagValue(flags, "--source-agent") !== undefined,
    refs: getFlagValue(flags, "--refs") !== undefined,
    expiresAfterDays: getFlagValue(flags, "--expires-after-days") !== undefined,
  };
  return (
    pathContext
      ? suggestTagsForPath(fileSystem, pathContext)
      : Effect.succeed<PathTagSuggestion>({
          tags: [],
          matches: [],
          unmatched: [],
        })
  ).pipe(
    Effect.map((pathTags) => ({
      mappedTags: pathTags.tags,
      pathMatches: pathTags.matches,
      unmatchedPaths: pathTags.unmatched,
      tags: mergeTagValues(explicitTags, pathTags.tags),
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
  return metadata.updatedBy !== "";
}

export function comparableText(parts: EmbeddingDocumentParts): string {
  return [parts.content, parts.tags, parts.context].join(" ");
}

export function storedComparableText(row: JsonObject): string {
  return comparableText({
    content: stringValue(row.content),
    tags: stringValue(row.tags),
    context: stringValue(row.context),
  });
}

/** How a CLI caller states intent after a refused add. */
const ADD_INTENT_HINTS: AddIntentHints = {
  updateId: (id) => `--update-id ${id}`,
  createNew: "--create-new",
};

/** One active memory an upsert query matched, as reported to the caller. */
type UpsertMatch = {
  id: number;
  /** Search rank of the record for the upsert query, 0 to 100. */
  rank_score: number;
  /** Share of terms the record and the new content have in common, 0 to 1. */
  text_overlap: number;
  memory_type: string;
  status: string;
  content_head: string;
  shared_identifiers: string[];
};

function upsertMatch(
  matched: JsonObject,
  content: string,
  metadata: AddMetadata,
): UpsertMatch {
  return {
    id: Number(matched.id ?? 0),
    rank_score: Number(matched.score ?? 0),
    text_overlap: compareMemoryFact(
      storedComparableText(matched),
      comparableText(addEmbeddingDocumentParts(content, metadata)),
    ).similarity,
    memory_type: stringValue(matched.memory_type, "convention"),
    status: stringValue(matched.status, "active"),
    // 120 characters plus the ellipsis.
    content_head: contentSnippet(matched.content, 121),
    shared_identifiers: sharedIdentifiers(
      stringValue(matched.content),
      content,
    ),
  };
}

/** The near-duplicate of a new memory, if any, and its strongly related records. */
type Neighbourhood = {
  duplicate: DuplicateMatch | undefined;
  related: JsonObject[];
};

function addNeighbourhood(
  write: AddWrite,
): Effect.Effect<Neighbourhood, MemoryDatabaseError> {
  const document = addEmbeddingDocumentParts(write.content, write.metadata);
  return detectPotentialConflicts(write.database, document).pipe(
    Effect.map((neighbours) => ({
      // --create-new says the caller read the records and this is a different fact.
      duplicate: hasFlag(write.flags, "--create-new")
        ? undefined
        : nearDuplicate(
            comparableText(document),
            neighbours.map((row) => ({
              id: Number(row.id),
              text: storedComparableText(row),
            })),
          ),
      related: neighbours.filter((row) => row.match_strength === "strong"),
    })),
  );
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
    match?: UpsertMatch;
    reconciliation?: JsonObject;
  } = {},
) {
  const { sizeReport, match, reconciliation = {} } = extras;
  const payload: JsonObject = match
    ? { mode, id, upsert_match: match, ...reconciliation }
    : { mode, id, ...reconciliation };
  attachSizeSummary(payload, sizeReport);
  printCommandOutput({ command: "add", outputMode }, payload);
}

/** Everything one `add` invocation writes with. */
type AddWrite = {
  database: MemoryDatabaseApi;
  flags: CommandFlags;
  content: string;
  metadata: AddMetadata;
  outputMode: CommandContext["outputMode"];
};

/** What an add would do, for --dry-run: the action and why it is refused, if it is. */
type AddPlan = {
  action: UpsertDecision;
  refusal?: string | undefined;
  candidates: UpsertMatch[];
  duplicate?: DuplicateMatch | undefined;
  /** The stored memory an update replaces. */
  target?: JsonObject | undefined;
};

function addDryRunPayload(
  plan: AddPlan,
  refusal: string | undefined,
): JsonObject {
  const payload: JsonObject = {
    command: "add",
    dry_run: true,
    action: refusal === undefined ? plan.action : "refuse",
  };
  const [best] = plan.candidates;
  if (best) {
    payload.would_match = best;
  }
  if (plan.action === "refuse") {
    payload.candidates = plan.candidates;
  }
  if (plan.duplicate) {
    payload.duplicate = { ...plan.duplicate };
  }
  if (refusal !== undefined) {
    payload.note = refusal;
  }
  return payload;
}

/** --emit-candidate checks the memory like --dry-run and writes it to a file, not the database. */
function addIsDryRun(flags: CommandFlags): boolean {
  return hasFlag(flags, "--dry-run") || hasFlag(flags, "--emit-candidate");
}

/**
 * --emit-candidate <file>: a child agent's finding, checked like a real add
 * and appended to a file for the parent to write with `import --review`.
 * Returns the fields to add to the dry-run output; `blocked` says the add
 * itself would be refused.
 */
function emitCandidate(
  write: AddWrite,
  plan: AddPlan,
  blocked: boolean,
): JsonObject {
  if (!hasFlag(write.flags, "--emit-candidate")) {
    return {};
  }
  const path = getFlagValue(write.flags, "--emit-candidate");
  if (path === undefined) {
    usageError("--emit-candidate needs a file path, such as findings.json.");
  }
  if (blocked) {
    return { candidate_emitted: false };
  }
  if (plan.target) {
    return {
      candidate_emitted: false,
      note: `A candidate file holds new memories only, and this add would update memory ${Number(plan.target.id)}. Report that id and the new content to the parent agent, which runs the update.`,
    };
  }
  const { content, metadata } = write;
  const candidate: JsonObject = {
    content,
    tags: metadata.tags,
    context: metadata.memo,
    memory_type: metadata.memoryType,
    certainty: metadata.certainty,
    evidence: metadata.evidence ?? [],
    validation_gaps: metadata.validationGaps ?? [],
    refs: metadata.refs,
    source_agent: metadata.sourceAgent,
  };
  if (
    metadata.expiresAfterDays !== undefined &&
    metadata.expiresAfterDays !== null
  ) {
    candidate.expires_after_days = metadata.expiresAfterDays;
  }
  return {
    candidate_emitted: true,
    candidate_file: path,
    candidates_in_file: appendCandidate(path, candidate),
    note: `Nothing was written to the database. Hand ${path} to the parent agent, which writes its candidates with 'machine-memory import ${path} --review'.`,
  };
}

/** Prints what the add would do and exits the way the real write would. */
function runAddDryRun(
  write: AddWrite,
  plan: AddPlan,
): Effect.Effect<boolean, MemoryDatabaseError> {
  return Effect.gen(function* () {
    const { content, metadata } = write;
    const { target } = plan;
    const replacement = target
      ? yield* assessContentReplacement(
          write.database,
          target,
          content,
          hasFlag(write.flags, "--allow-drop"),
        )
      : undefined;
    const size = embeddingSizeReport(
      target
        ? addUpsertEmbeddingDocument(target, content, metadata)
        : addEmbeddingDocumentParts(content, metadata),
    );
    const refusal = plan.refusal ?? replacement?.refusal;
    const payload = addDryRunPayload(plan, refusal);
    if (target && replacement) {
      payload.update_id = Number(target.id);
      payload.replacement = replacementSummary(replacement);
      const dropped = droppedFor(target, content);
      if (dropped) {
        payload.dropped = dropped;
      }
    }
    payload.size = size;
    const blocked = !size.within_budget || refusal !== undefined;
    const emitted = emitCandidate(write, plan, blocked);
    Object.assign(payload, emitted);
    yield* Effect.sync(() => {
      printCommandOutput(
        { command: "add", outputMode: write.outputMode },
        payload,
      );
      if (blocked || emitted.candidate_emitted === false) {
        process.exitCode = 1;
      }
    });
    return true;
  });
}

/** The active memory an add replaces: a strong upsert match, or the one --update-id names. */
function activeUpsertTarget(
  database: MemoryDatabaseApi,
  id: number,
  via: "match" | "id",
): Effect.Effect<JsonObject, MemoryDatabaseError | CommandError> {
  return getMemoryById(database, id).pipe(
    Effect.flatMap((row) => {
      if (row?.status === "active") {
        return Effect.succeed(row);
      }
      if (via === "match") {
        return Effect.fail(
          commandError(
            "add",
            `Memory ${id} is no longer active; retry the match.`,
          ),
        );
      }
      return Effect.fail(
        commandError(
          "add",
          row
            ? `Memory ${id} is ${stringValue(row.status)}; --update-id needs an active memory. Nothing was written.`
            : `Memory ${id} was not found in repository '${repositoryForCurrentDirectory()}'. Nothing was written.`,
        ),
      );
    }),
  );
}

/** Replaces the content of `target` from an add; omitted fields keep their stored values. */
function runStrongUpsertUpdate(
  write: AddWrite,
  target: JsonObject,
): Effect.Effect<boolean, MemoryDatabaseError | CommandError> {
  return Effect.gen(function* () {
    const { database, content, metadata, outputMode } = write;
    const targetId = Number(target.id);
    const breakdown = yield* validateEmbeddingFit(
      "add",
      `Memory ${targetId}`,
      addUpsertEmbeddingDocument(target, content, metadata),
    );
    const replacement = yield* assessContentReplacement(
      database,
      target,
      content,
      hasFlag(write.flags, "--allow-drop"),
    );
    if (replacement.refusal !== undefined) {
      return yield* commandError("add", replacement.refusal);
    }
    const updated = jsonObject(
      yield* updateFromAddPayload(
        database,
        targetId,
        content,
        metadata,
        jsonNumber(target.update_count) ?? 0,
      ),
    );
    if (!updated) {
      return yield* commandError(
        "add",
        `Memory ${targetId} changed concurrently; retry.`,
      );
    }
    const reconciliation = yield* reconcileWrite(database, target, content);
    yield* Effect.sync(() => {
      warnReconciliation(`Update of memory ${targetId}`, reconciliation);
      printUpsertResult(outputMode, "updated", targetId, {
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

/** `--update-id <id>`: this content restates that memory. */
function maybeHandleUpdateId(
  write: AddWrite,
): Effect.Effect<boolean, MemoryDatabaseError | CommandError> {
  const { flags, metadata } = write;
  const id = parseIntegerFlag(flags, "--update-id");
  if (id === undefined) {
    return Effect.succeed(false);
  }
  if (id === null || id <= 0) {
    usageError("--update-id must be a memory id.");
  }
  if (hasFlag(flags, "--create-new")) {
    usageError(
      "--update-id replaces a stored memory and --create-new adds a new one; give one of them.",
    );
  }
  return Effect.gen(function* () {
    const target = yield* activeUpsertTarget(write.database, id, "id");
    assertAddEvidence(metadata, target);
    if (addIsDryRun(flags)) {
      return yield* runAddDryRun(write, {
        action: "update",
        candidates: [],
        target,
      });
    }
    return yield* runStrongUpsertUpdate(write, target);
  });
}

/**
 * Creates the memory an upsert query did not resolve; echoes a weak match it
 * passed over. The size is checked before the duplicate, as in a plain add.
 */
function runUpsertCreate(
  write: AddWrite,
  match: UpsertMatch | undefined,
  duplicate: DuplicateMatch | undefined,
): Effect.Effect<boolean, MemoryDatabaseError | CommandError> {
  return Effect.gen(function* () {
    const { database, content, metadata, outputMode } = write;
    const breakdown = yield* validateEmbeddingFit(
      "add",
      "Memory",
      addEmbeddingDocumentParts(content, metadata),
    );
    if (duplicate) {
      return yield* commandError(
        "add",
        duplicateRefusal(duplicate, ADD_INTENT_HINTS),
      );
    }
    const createdResult = yield* addInsert(database, content, metadata);
    const createdId =
      jsonNumber(jsonObject(createdResult)?.lastInsertRowid) ?? 0;
    yield* Effect.sync(() => {
      warnEmptyTags(createdId, metadata);
      printUpsertResult(outputMode, "created", createdId, {
        sizeReport: breakdown,
        match,
      });
    });
    return true;
  });
}

/**
 * `--upsert-match <query>`: update a strong match, refuse a weak one with its
 * candidates, and create when nothing matched or --create-new says this is a
 * different fact. A create is still refused when it duplicates a record.
 */
function maybeHandleAddUpsert(
  write: AddWrite,
): Effect.Effect<boolean, MemoryDatabaseError | CommandError> {
  const { database, flags, content, metadata } = write;
  const upsertQuery = parseAddUpsertQuery(flags);
  if (upsertQuery === undefined) {
    return Effect.succeed(false);
  }
  return Effect.gen(function* () {
    const minScore = yield* resolveUpsertMinScore(flags);
    const matches = yield* findMemoryMatches(database, upsertQuery);
    const candidates = matches.map((row) =>
      upsertMatch(row, content, metadata),
    );
    const [best] = candidates;
    const decision = decideUpsert({
      match: best,
      minScore,
      createNew: hasFlag(flags, "--create-new"),
    });
    const target =
      decision === "update" && best
        ? yield* activeUpsertTarget(database, best.id, "match")
        : undefined;
    assertAddEvidence(metadata, target);
    const duplicate =
      decision === "create"
        ? (yield* addNeighbourhood(write)).duplicate
        : undefined;
    const refusal =
      decision === "refuse"
        ? upsertRefusal(candidates, minScore, ADD_INTENT_HINTS)
        : duplicate && duplicateRefusal(duplicate, ADD_INTENT_HINTS);
    if (addIsDryRun(flags)) {
      return yield* runAddDryRun(write, {
        action: decision,
        refusal,
        candidates,
        duplicate,
        target,
      });
    }
    if (decision === "refuse" && refusal !== undefined) {
      return yield* commandError("add", refusal);
    }
    return target
      ? yield* runStrongUpsertUpdate(write, target)
      : yield* runUpsertCreate(write, best, duplicate);
  });
}

/** --path that matched nothing adds no tags; say so instead of writing silently. */
function warnUnmatchedPaths(metadata: AddMetadata): void {
  if (metadata.unmatchedPaths.length > 0) {
    warnOnStderr(
      `--path ${metadata.unmatchedPaths.join(",")} matched no prefix of the tag map, so it added no tags. List the prefixes with 'machine-memory tag-map list'.`,
    );
  }
}

function warnEmptyTags(id: number, metadata: AddMetadata): void {
  if (metadata.tags === "") {
    warnOnStderr(
      `Memory ${id} was written without tags, so tag filters cannot find it. Add some with 'machine-memory update ${id} --add-tags <tags>'.`,
    );
  }
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
  relatedCount: number;
  statusCascadeCount: number;
  sizeReport?: EmbeddingSizeReport;
}): JsonObject {
  const payload: JsonObject = {
    id: params.createdId,
    status: "created",
    related_count: params.relatedCount,
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
  related: JsonObject[];
  statusCascade: JsonObject[];
  sizeReport?: EmbeddingSizeReport;
}) {
  const {
    outputMode,
    createdId,
    created,
    content,
    metadata,
    related,
    statusCascade,
    sizeReport,
  } = params;
  if (outputMode.jsonMin || outputMode.quiet) {
    const minimal: JsonObject = { id: createdId };
    attachSizeSummary(minimal, sizeReport);
    printJson(minimal);
    return;
  }
  if (outputMode.brief) {
    printJson(
      briefAddPayload({
        createdId,
        relatedCount: related.length,
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
  if (metadata.pathMatches.length > 0) {
    Object.assign(payload, { path_tag_matches: metadata.pathMatches });
  }
  if (related.length > 0) {
    Object.assign(payload, { related });
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
  attachSizeSummary(payload, sizeReport);
  printCommandOutput({ command: "add", outputMode }, payload);
}

/** An add that names no existing memory: refuse a near-duplicate, else create. */
function runPlainAdd(
  write: AddWrite,
): Effect.Effect<boolean, MemoryDatabaseError | CommandError> {
  return Effect.gen(function* () {
    const { database, content, metadata, outputMode } = write;
    const { duplicate, related } = yield* addNeighbourhood(write);
    const refusal = duplicate && duplicateRefusal(duplicate, ADD_INTENT_HINTS);
    if (addIsDryRun(write.flags)) {
      return yield* runAddDryRun(write, {
        action: "create",
        refusal,
        candidates: [],
        duplicate,
      });
    }
    // An oversized memory is invalid whatever it duplicates, so size comes first.
    const sizeReport = yield* validateEmbeddingFit(
      "add",
      "Memory",
      addEmbeddingDocumentParts(content, metadata),
    );
    if (refusal !== undefined) {
      return yield* commandError("add", refusal);
    }
    const result = yield* addInsert(database, content, metadata);
    const insertId = jsonNumber(jsonObject(result)?.lastInsertRowid) ?? 0;
    const created = yield* getMemoryById(database, insertId);
    const createdId = Number(created?.id ?? insertId);
    const statusCascade =
      metadata.memoryType === "status"
        ? yield* findStatusCascadeCandidates(database, metadata.tags, createdId)
        : [];
    yield* Effect.sync(() => {
      warnEmptyTags(createdId, metadata);
      printAddResult({
        outputMode,
        createdId,
        created,
        content,
        metadata,
        related,
        statusCascade,
        sizeReport,
      });
    });
    return true;
  });
}

/**
 * After a thread's first write to a repository, says once on stderr how to
 * review everything the thread wrote. A writer without a thread has nothing
 * to scope that review to, and later writes stay quiet: either the thread has
 * touched a second memory, or history holds a revision it wrote.
 */
function remindOfCheckpoint(commandCtx: CommandContext) {
  const writer = currentWriter();
  if (!writer.includes(":") || hasFlag(commandCtx.flags, "--dry-run")) {
    return Effect.void;
  }
  const repository = repositoryForCurrentDirectory();
  return requireDatabase(commandCtx)
    .get(
      `SELECT
        (SELECT COUNT(*) FROM memories
          WHERE repository = ? AND (source_agent = ? OR last_updated_by = ?))
        + (SELECT COUNT(*) FROM memory_history
          WHERE repository = ? AND (source_agent = ? OR last_updated_by = ?))
        AS written`,
      [repository, writer, writer, repository, writer, writer],
    )
    .pipe(
      Effect.map((row) => {
        if (jsonNumber(jsonObject(row)?.written) === 1) {
          warnOnStderr(
            `This is the first memory this thread wrote here. Before your final response, review what it wrote with 'machine-memory checkpoint --mine ${hasFlag(commandCtx.flags, "--remote") ? "--remote" : "--local"}'.`,
          );
        }
      }),
    );
}

/** Runs a write command, then the reminder above. */
export function withCheckpointReminder<E, R>(
  handler: (commandCtx: CommandContext) => Effect.Effect<void, E, R>,
) {
  return (commandCtx: CommandContext) =>
    handler(commandCtx).pipe(Effect.tap(() => remindOfCheckpoint(commandCtx)));
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
    warnUnmatchedPaths(metadata);
    const write: AddWrite = { database, flags, content, metadata, outputMode };
    if (
      (yield* maybeHandleUpdateId(write)) ||
      (yield* maybeHandleAddUpsert(write))
    ) {
      return;
    }
    assertAddEvidence(metadata);
    yield* runPlainAdd(write);
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

/** The new content, or undefined when the update changes only other fields. */
function resolveUpdateContent(
  flags: CommandFlags,
  contentFromArg: string | undefined,
  fileSystem: CommandContext["fileSystem"],
): Effect.Effect<string | undefined, unknown> {
  return parseContentFromFileFlag(flags, fileSystem).pipe(
    Effect.map((contentFromFile) => {
      if (contentFromArg && contentFromFile !== undefined) {
        usageError(`Usage: ${UPDATE_USAGE}`);
      }
      if (contentFromFile === undefined && !contentFromArg) {
        if (!UPDATE_FIELD_FLAGS.some((flag) => hasFlag(flags, flag))) {
          usageError(
            `Give the new content or a field to change. Usage: ${UPDATE_USAGE}`,
          );
        }
        return undefined;
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

/** --updated-by, or the detected writer; undefined leaves last_updated_by as stored. */
function updatedByFlag(flags: CommandFlags): string | undefined {
  return getFlagValue(flags, "--updated-by") ?? (currentWriter() || undefined);
}

function updateSpec(
  clause: string,
  value: string | number | null | undefined,
): UpdateSpec[] {
  return value === undefined ? [] : [{ clause, value }];
}

/** The SET clauses of one row's update; only fields that were given are written. */
function updateSetsAndParams(flags: CommandFlags, changes: RowChanges) {
  const refs = parseRefsFlag(flags);
  const requestedType = requireMemoryType(flags);
  const specs = [
    ...updateSpec("content = ?", changes.content),
    ...updateSpec("tags = ?", changes.tags),
    ...updateSpec("context = ?", changes.context),
    ...updateSpec("memory_type = ?", requestedType),
    ...updateSpec("certainty = ?", requireCertainty(flags)),
    ...updateSpec("last_updated_by = ?", updatedByFlag(flags)),
    ...updateSpec(
      "refs = ?",
      refs === undefined ? undefined : JSON.stringify(refs),
    ),
    ...updateSpec(
      "expires_after_days = ?",
      parseIntegerFlag(flags, "--expires-after-days", {
        allowNullLiteral: true,
      }),
    ),
    ...evidenceUpdateSpecs(parseEvidenceFlag(flags), changes.validationGaps),
  ];
  const sets = [
    ...specs.map((spec) => spec.clause),
    "updated_at = datetime('now')",
    "update_count = COALESCE(update_count, 0) + 1",
  ];
  if (
    requestedType !== undefined &&
    requestedType !== "status" &&
    !hasFlag(flags, "--expires-after-days")
  ) {
    sets.push("expires_after_days = NULL");
  }
  return { sets, params: specs.map((spec) => spec.value) };
}

/** A row to update, the update_count it was read at, and its SET clauses. */
type BatchTarget = {
  updateCount: number;
  update: { sets: string[]; params: (string | number | null)[] };
};

function runBatchMemoryUpdate(
  database: MemoryDatabaseApi,
  targetIds: number[],
  targets: Map<number, BatchTarget>,
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
      const target = targets.get(targetId);
      if (!target) {
        missingIds.push(targetId);
        continue;
      }
      const { update } = target;
      const outcome = yield* database
        .get(
          `UPDATE memories SET ${update.sets.join(", ")} WHERE repository = ? AND id = ? AND COALESCE(update_count, 0) = ?${activeOnly ? " AND status = 'active'" : ""} RETURNING *`,
          [
            ...update.params,
            repositoryForCurrentDirectory(),
            targetId,
            target.updateCount,
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
  replacements: Map<number, ReplacementAssessment>,
): Effect.Effect<void, CommandError> {
  return Effect.gen(function* () {
    const targets: JsonObject[] = [];
    let refused = false;
    for (const entry of prospective) {
      const size = embeddingSizeReport(entry.document);
      const replacement = replacements.get(entry.id);
      refused =
        refused || !size.within_budget || replacement?.action === "refuse";
      const target: JsonObject = { id: entry.id, size };
      const dropped = droppedFor(entry.previous, entry.document.content);
      if (dropped) {
        target.dropped = dropped;
      }
      if (replacement) {
        target.replacement = replacementSummary(replacement);
      }
      if (replacement?.refusal !== undefined) {
        target.note = replacement.refusal;
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
      // A dry run exits the way the real write would.
      if (refused) {
        process.exitCode = 1;
      }
    });
  });
}

function validateProspectiveUpdates(
  prospective: ProspectiveUpdate[],
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
  if (targetIds.length > 1) {
    usageError(
      `update replaces the content of one memory, and ${targetIds.length} ids were given (${targetIds.join(", ")}). Update each memory with its own content, or leave the content out to change only fields. Nothing was written.`,
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

/** The replacement assessment of every target whose content the update replaces. */
function assessReplacements(
  database: MemoryDatabaseApi,
  prospective: ProspectiveUpdate[],
  allowDrop: boolean,
): Effect.Effect<Map<number, ReplacementAssessment>, MemoryDatabaseError> {
  return Effect.forEach(
    prospective.filter((entry) => entry.changes.content !== undefined),
    (entry) =>
      assessContentReplacement(
        database,
        entry.previous,
        entry.document.content,
        allowDrop,
      ).pipe(Effect.map((assessment) => [entry.id, assessment] as const)),
  ).pipe(Effect.map((entries) => new Map(entries)));
}

/** Writes the validated updates and prints what changed and what was lost. */
function applyUpdates(
  commandCtx: CommandContext,
  targetIds: number[],
  prospective: ProspectiveUpdate[],
  sizeReports: Map<number, EmbeddingSizeReport>,
): Effect.Effect<void, MemoryDatabaseError> {
  return Effect.gen(function* () {
    const { flags } = commandCtx;
    const database = requireDatabase(commandCtx);
    const result = yield* runBatchMemoryUpdate(
      database,
      targetIds,
      new Map(
        prospective.map((entry) => [
          entry.id,
          {
            updateCount: entry.updateCount,
            update: updateSetsAndParams(flags, entry.changes),
          },
        ]),
      ),
      hasFlag(flags, "--match"),
    );
    const { rows, missingIds } = result;
    const updatedIds = new Set(rows.map((row) => Number(row.id)));
    const reconciliations = yield* Effect.forEach(
      prospective.filter((entry) => updatedIds.has(entry.id)),
      (entry) =>
        reconcileWrite(database, entry.previous, entry.document.content),
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
    if (content !== undefined) {
      assertSingleContentTarget(targetIds);
    }
    const prospective = yield* prospectiveUpdates(
      flags,
      database,
      targetIds,
      content,
    );
    yield* assertExpectedUpdateCount(flags, prospective);
    const replacements = yield* assessReplacements(
      database,
      prospective,
      hasFlag(flags, "--allow-drop"),
    );
    if (hasFlag(flags, "--dry-run")) {
      yield* runUpdateDryRun(commandCtx, prospective, replacements);
      return;
    }
    const refused = [...replacements.values()].find(
      (assessment) => assessment.refusal !== undefined,
    );
    if (refused?.refusal !== undefined) {
      return yield* commandError("update", refused.refusal);
    }
    const sizeReports = yield* validateProspectiveUpdates(prospective);
    yield* applyUpdates(commandCtx, targetIds, prospective, sizeReports);
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
  const updatedBy = updatedByFlag(flags);
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
    `Deprecating ${rows.map((row) => `#${Number(row.id)}`).join(", ")}`,
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
    const targets = new Map<number, BatchTarget>();
    for (const id of targetIds) {
      const row = yield* getMemoryById(database, id);
      if (row) {
        targets.set(id, {
          updateCount: jsonNumber(row.update_count) ?? 0,
          update: { sets, params },
        });
      }
    }
    const result = yield* runBatchMemoryUpdate(
      database,
      targetIds,
      targets,
      hasFlag(flags, "--match"),
    );
    const { rows, missingIds } = result;
    const reviewCandidates = yield* findReviewCandidates(
      database,
      rows.map((row) => ({
        id: Number(row.id),
        memoryType: stringValue(row.memory_type, "convention"),
        text: stringValue(row.content),
      })),
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

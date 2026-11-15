import {
  assessReplacement,
  buildFtsQuery,
  canonicalTags,
  changedText,
  compareMemoryFact,
  decideUpsert,
  decodeRequest,
  droppedDetails,
  droppedNames,
  duplicateRefusal,
  editTags,
  editValidationGaps,
  embeddingBudgetMessage,
  embeddingSizeReport,
  evidenceWriteError,
  extractQueryIdentifiers,
  extractTerms,
  hasDroppedDetails,
  MemorySummarySchema,
  nameHoldersFromRows,
  nameHoldersQuery,
  nearDuplicate,
  normalizeMemoryAddArgs,
  normalizeStoredMemoryRow,
  reviewCandidateRowsQuery,
  reviewNames,
  reviewsDependents,
  selectReviewCandidates,
  sharedIdentifiers,
  StoredMemoryRowSchema,
  upsertRefusal,
  type AddIntentHints,
  type JsonObject,
  type MatchedUpdateTarget,
  type MemoryAddArgs,
  type MemoryDeprecateResult,
  type MemoryRow,
  type MemoryStatus,
  type MemoryType,
  type MemoryWriteResult,
  type ProductRequest,
  type ReviewCandidateRow,
  type UpsertMatchInfo,
  sqliteTimestamp,
} from "@machine-memory/contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  fetchProductRow,
  fetchRankedProductRows,
  memoryNotFound,
  type ApiContext,
  type ProductHandlers,
} from "./api-context";
import { badRequest, conflict, notFound } from "./http-failure";
import {
  INSERT_SQL,
  insertParams,
  writerOf,
  updateSets,
  type InsertInput,
} from "./product-api";
import {
  contentHead,
  scoredResultRow,
  scoreMemoryRows,
  toProductRow,
} from "./product-logic";

/** Stores tags in the form the doctor expects: trimmed, lowercased, deduplicated. */
const withCanonicalTags = <T extends { readonly tags?: string | undefined }>(
  input: T,
): T =>
  input.tags === undefined
    ? input
    : { ...input, tags: canonicalTags(input.tags) };

/** How an API caller states intent after a refused add. */
const ADD_INTENT_HINTS: AddIntentHints = {
  updateId: (id) => `update_id ${id}`,
  createNew: "create_new true",
};

const UPSERT_CANDIDATES_SHOWN = 3;

/** The best active matches for a topic query, strongest first, at most three. */
const findProductMatches = (
  ctx: ApiContext,
  repository: string,
  query: string,
) =>
  Effect.gen(function* () {
    const terms = extractTerms(query);
    const ftsQuery = buildFtsQuery(terms);
    if (ftsQuery === undefined) {
      return [];
    }
    const rows = yield* fetchRankedProductRows(
      ctx,
      ftsQuery,
      repository,
      { status: "active" },
      5,
    );
    return scoreMemoryRows(rows, {
      terms,
      identifiers: extractQueryIdentifiers(query),
    })
      .slice(0, UPSERT_CANDIDATES_SHOWN)
      .map((scored) => ({ row: scoredResultRow(scored), score: scored.score }));
  });

/**
 * Refuses new content that would lose details of the stored record: a path,
 * flag or symbol no other active record mentions, or nearly all of its terms.
 */
const guardReplacement = (
  ctx: ApiContext,
  existing: MemoryRow,
  next: string,
  allowDrop: boolean,
) =>
  Effect.gen(function* () {
    const names = droppedNames(existing.content, next);
    const query = nameHoldersQuery({
      repository: existing.repository,
      excludeId: existing.id,
      names,
    });
    const assessment = assessReplacement({
      id: existing.id,
      previous: existing.content,
      next,
      memoryType: existing.memory_type,
      holders: nameHoldersFromRows(
        names.length === 0
          ? []
          : yield* ctx.sql.unsafe<JsonObject>(query.sql, query.params),
      ),
      allowDrop,
      allowDropHint: "allow_drop true",
    });
    if (assessment.refusal !== undefined) {
      return yield* badRequest(assessment.refusal);
    }
  });

/**
 * Active records that may rely on a changed or retired premise: they cite it
 * by id, or share a name with its text that few other records carry.
 */
const fetchReviewCandidates = (
  ctx: ApiContext,
  repository: string,
  premises: ReadonlyArray<{
    readonly id: number;
    readonly memory_type: MemoryType;
    /** The whole content when retired; the removed or rewritten part when updated. */
    readonly text: string;
  }>,
  alsoExclude: readonly number[],
) =>
  Effect.gen(function* () {
    const groups = [];
    for (const premise of premises) {
      if (!reviewsDependents(premise.memory_type)) {
        continue;
      }
      const names = reviewNames(premise.text);
      const holderQuery = nameHoldersQuery({
        repository,
        excludeId: premise.id,
        names,
      });
      const holders = nameHoldersFromRows(
        names.length === 0
          ? []
          : yield* ctx.sql.unsafe<JsonObject>(
              holderQuery.sql,
              holderQuery.params,
            ),
      );
      const rowQuery = reviewCandidateRowsQuery({
        repository,
        premiseId: premise.id,
        holders,
      });
      const rows = yield* ctx.sql.unsafe<JsonObject>(
        rowQuery.sql,
        rowQuery.params,
      );
      groups.push({ id: premise.id, holders, rows: rows.map(toProductRow) });
    }
    return selectReviewCandidates(
      groups,
      new Set([...premises.map((premise) => premise.id), ...alsoExclude]),
    ).map((candidate): ReviewCandidateRow => ({
      ...Schema.decodeSync(MemorySummarySchema)(candidate.row),
      shared_identifiers: candidate.shared_identifiers,
      cites: candidate.cites,
    }));
  });

/** Dropped details and dependent records for a content or status change. */
const reconcileUpdate = (
  ctx: ApiContext,
  repository: string,
  existing: MemoryRow,
  fields: { content?: string; status?: MemoryStatus },
) =>
  Effect.gen(function* () {
    const extra: Pick<MemoryWriteResult, "dropped" | "review_candidates"> = {};
    const contentChanged =
      fields.content !== undefined && fields.content !== existing.content;
    const retired = fields.status !== undefined && fields.status !== "active";
    if (contentChanged && fields.content !== undefined) {
      const dropped = droppedDetails(existing.content, fields.content);
      if (hasDroppedDetails(dropped)) {
        Object.assign(extra, { dropped });
      }
    }
    if (contentChanged || retired) {
      // Retiring withdraws the whole content; an update only what it removes or rewrites.
      const text =
        retired || fields.content === undefined
          ? existing.content
          : changedText(existing.content, fields.content);
      const candidates = yield* fetchReviewCandidates(
        ctx,
        repository,
        [{ id: existing.id, memory_type: existing.memory_type, text }],
        [],
      );
      if (candidates.length > 0) {
        Object.assign(extra, { review_candidates: candidates });
      }
    }
    return extra;
  });

const insertProductRow = (ctx: ApiContext, input: InsertInput) =>
  Effect.gen(function* () {
    const result = yield* ctx.d1
      .prepare(`${INSERT_SQL} RETURNING *`)
      .bind(...insertParams(input))
      .first<JsonObject>();
    if (result === null) {
      return yield* Effect.die(new Error("Insert did not return a memory."));
    }
    return toProductRow(result);
  });

/** Active records nearest to a prospective memory, strongest match first. */
const fetchNeighbours = (ctx: ApiContext, insert: InsertInput) =>
  Effect.gen(function* () {
    const terms = extractTerms(
      [insert.content, insert.tags, insert.context].join(" "),
    );
    const ftsQuery = buildFtsQuery(terms);
    if (ftsQuery === undefined) {
      return [];
    }
    const rows = yield* fetchRankedProductRows(
      ctx,
      ftsQuery,
      insert.repository,
      { status: "active" },
      5,
    );
    return scoreMemoryRows(rows, {
      terms,
      identifiers: extractQueryIdentifiers(insert.content),
    }).map(scoredResultRow);
  });

const comparableText = (memory: {
  readonly content: string;
  readonly tags: string;
  readonly context: string;
}) => [memory.content, memory.tags, memory.context].join(" ");

/**
 * Inserts a new memory unless an active record already states nearly the same
 * thing and the caller did not ask for a new record. Without `upsertMatch` the
 * result lists strongly related records; a create over a weak upsert match
 * echoes that match instead.
 */
const createProduct = (
  ctx: ApiContext,
  args: MemoryAddArgs,
  upsertMatch: UpsertMatchInfo | undefined,
) =>
  Effect.gen(function* () {
    // Every create path checks this: plain adds, unmatched upserts and create_new.
    if (
      args.expires_after_days !== undefined &&
      args.memory_type !== "status"
    ) {
      return yield* badRequest(
        "expires_after_days is only valid for status memories.",
      );
    }
    const evidenceError = evidenceWriteError(args);
    if (evidenceError !== undefined) {
      return yield* badRequest(evidenceError);
    }
    const insert: InsertInput = {
      repository: args.repository,
      content: args.content,
      tags: args.tags ?? "",
      context: args.context ?? "",
      memory_type: args.memory_type,
      status: args.status,
      certainty: args.certainty,
      evidence: args.evidence,
      validation_gaps: args.validation_gaps,
      expires_after_days: args.expires_after_days ?? null,
      source_agent: args.source_agent,
    };
    const size = embeddingSizeReport(insert);
    if (!size.within_budget) {
      return yield* badRequest(embeddingBudgetMessage("Memory", size));
    }
    const neighbours = yield* fetchNeighbours(ctx, insert);
    const duplicate =
      args.create_new === true
        ? undefined
        : nearDuplicate(
            comparableText(insert),
            neighbours.map((row) => ({
              id: row.id,
              text: comparableText(row),
            })),
          );
    if (duplicate !== undefined) {
      return yield* badRequest(duplicateRefusal(duplicate, ADD_INTENT_HINTS));
    }
    const memory = yield* insertProductRow(ctx, insert);
    const result: MemoryWriteResult = {
      written_to: args.repository,
      id: memory.id,
      memory,
      size,
    };
    if (upsertMatch !== undefined) {
      return { ...result, upsert_match: upsertMatch };
    }
    const related = neighbours.filter((row) => row.match_strength === "strong");
    return related.length > 0 ? { ...result, related } : result;
  });

const strongUpsertError = (
  input: ProductRequest<"add">,
  prospective: { memory_type: MemoryType },
  existing: MemoryRow,
): string | undefined =>
  input.expires_after_days !== undefined && prospective.memory_type !== "status"
    ? "expires_after_days is only valid for status memories."
    : evidenceWriteError(input, existing);

/** The active memory an add replaces: a strong upsert match, or the one named by update_id. */
const upsertTarget = (
  ctx: ApiContext,
  repository: string,
  targetId: number,
  viaMatch: boolean,
) =>
  Effect.gen(function* () {
    const existing = yield* fetchProductRow(ctx, repository, targetId);
    if (existing?.status === "active") {
      return existing;
    }
    if (viaMatch) {
      return yield* conflict("Match changed; retry.");
    }
    if (!existing) {
      return yield* memoryNotFound(ctx, targetId, repository);
    }
    return yield* badRequest(
      `Memory ${targetId} is ${existing.status}; update_id needs an active memory.`,
    );
  });

/** The memory as the add would leave it: omitted fields keep their stored values. */
const upsertProspective = (
  existing: MemoryRow,
  input: ProductRequest<"add">,
) => ({
  content: input.content,
  tags: input.tags ?? existing.tags,
  context: input.context ?? existing.context,
  memory_type: input.memory_type ?? existing.memory_type,
  status: existing.status,
  certainty: input.certainty ?? existing.certainty,
});

/**
 * Replaces the content of an existing memory from an add: the strong upsert
 * match (`info`), or the memory named by update_id. Unset optional fields keep
 * the stored values, so this reads the raw request rather than defaulted add
 * arguments.
 */
const applyStrongUpsert = (
  ctx: ApiContext,
  input: ProductRequest<"add">,
  targetId: number,
  info: UpsertMatchInfo | undefined,
) =>
  Effect.gen(function* () {
    const existing = yield* upsertTarget(
      ctx,
      input.repository,
      targetId,
      info !== undefined,
    );
    const prospective = upsertProspective(existing, input);
    const invalid = strongUpsertError(input, prospective, existing);
    if (invalid !== undefined) {
      return yield* badRequest(invalid);
    }
    const size = embeddingSizeReport(prospective);
    if (!size.within_budget) {
      return yield* badRequest(embeddingBudgetMessage("Memory", size));
    }
    yield* guardReplacement(
      ctx,
      existing,
      input.content,
      input.allow_drop === true,
    );
    const update = updateSets({
      content: input.content,
      tags: input.tags,
      context: input.context,
      memory_type: input.memory_type,
      certainty: input.certainty,
      evidence: input.evidence,
      validation_gaps: input.validation_gaps,
      expires_after_days:
        prospective.memory_type !== "status" ? null : input.expires_after_days,
      source_agent: input.source_agent,
    })!; // Content is required, so updateSets always has a field.
    const rowData = yield* ctx.d1
      .prepare(
        `UPDATE memories SET ${update.sql} WHERE repository = ? AND id = ? AND status = 'active' AND update_count = ? RETURNING *`,
      )
      .bind(...update.params, input.repository, targetId, existing.update_count)
      .first<JsonObject>();
    if (rowData === null) {
      return yield* conflict("Memory changed concurrently; retry.");
    }
    const result: MemoryWriteResult = {
      mode: "updated",
      written_to: input.repository,
      id: targetId,
      memory: toProductRow(rowData),
      size,
      ...(yield* reconcileUpdate(ctx, input.repository, existing, {
        content: input.content,
      })),
    };
    return info === undefined ? result : { ...result, upsert_match: info };
  });

const upsertProductAdd = (
  ctx: ApiContext,
  input: ProductRequest<"add">,
  args: MemoryAddArgs,
  upsertQuery: string,
) =>
  Effect.gen(function* () {
    const matches = yield* findProductMatches(
      ctx,
      args.repository,
      upsertQuery,
    );
    const candidates = matches.map((match): UpsertMatchInfo => ({
      id: match.row.id,
      rank_score: match.score,
      text_overlap: compareMemoryFact(
        comparableText(match.row),
        [args.content, args.tags ?? "", args.context ?? ""].join(" "),
      ).similarity,
      memory_type: match.row.memory_type,
      status: match.row.status,
      content_head: contentHead(match.row.content),
      shared_identifiers: sharedIdentifiers(match.row.content, args.content),
    }));
    const best = candidates[0];
    const decision = decideUpsert({
      match: best,
      minScore: args.upsert_threshold,
      createNew: args.create_new === true,
    });
    if (decision === "refuse") {
      return yield* badRequest(
        upsertRefusal(candidates, args.upsert_threshold, ADD_INTENT_HINTS),
      );
    }
    if (decision === "create" || best === undefined) {
      return yield* createProduct(ctx, args, best);
    }
    return yield* applyStrongUpsert(ctx, input, best.id, best);
  });

/** Resolves the update target from exactly one of id or match. */
const resolveUpdateTarget = (
  ctx: ApiContext,
  repository: string,
  id: number | undefined,
  match: string | undefined,
) =>
  Effect.gen(function* () {
    if (match !== undefined) {
      const [best] = yield* findProductMatches(ctx, repository, match);
      if (!best) {
        return yield* notFound(
          `No active memory matched '${match}' in repository '${repository}'.`,
        );
      }
      const matched: MatchedUpdateTarget = {
        query: match,
        id: best.row.id,
        score: best.score,
      };
      return { targetId: best.row.id, matched };
    }
    if (id === undefined) {
      return yield* badRequest(
        "Provide either the numeric id or a match query.",
      );
    }
    return { targetId: id, matched: undefined };
  });

const validateUpdateFields = (
  existing: MemoryRow,
  targetId: number,
  input: ProductRequest<"update">,
): string | undefined => {
  if (input.superseded_by !== undefined && input.superseded_by === targetId) {
    return "A memory cannot supersede itself.";
  }
  const prospectiveType = input.memory_type ?? existing.memory_type;
  if (input.expires_after_days !== undefined && prospectiveType !== "status") {
    return "expires_after_days is only valid for status memories.";
  }
  return evidenceWriteError(input, existing);
};

/** The embedded fields of the memory as they would be after the update. */
const prospectiveUpdateDocument = (
  existing: MemoryRow,
  input: ProductRequest<"update">,
) => ({
  content: input.content ?? existing.content,
  tags: input.tags ?? existing.tags,
  context: input.context ?? existing.context,
});

const persistProductUpdate = (
  ctx: ApiContext,
  input: ProductRequest<"update">,
  targetId: number,
  existing: MemoryRow,
  outcome: {
    size: ReturnType<typeof embeddingSizeReport>;
    matched: MatchedUpdateTarget | undefined;
  },
) =>
  Effect.gen(function* () {
    // updateSets reads only the update fields of the request.
    const update = updateSets({
      ...input,
      expires_after_days:
        (input.memory_type ?? existing.memory_type) !== "status" &&
        existing.expires_after_days !== null
          ? null
          : input.expires_after_days,
    });
    let row = existing;
    if (update !== undefined) {
      const rowData = yield* ctx.d1
        .prepare(
          `UPDATE memories SET ${update.sql} WHERE repository = ? AND id = ? AND update_count = ?${outcome.matched !== undefined ? " AND status = 'active'" : ""} RETURNING *`,
        )
        .bind(
          ...update.params,
          input.repository,
          targetId,
          existing.update_count,
        )
        .first<JsonObject>();
      if (rowData === null) {
        return yield* conflict("Memory changed concurrently; retry.");
      }
      row = toProductRow(rowData);
    }
    const result: MemoryWriteResult = {
      written_to: input.repository,
      id: targetId,
      memory: row,
      size: outcome.size,
      ...(yield* reconcileUpdate(ctx, input.repository, existing, input)),
    };
    if (outcome.matched !== undefined) {
      Object.assign(result, { matched: outcome.matched });
    }
    return result;
  });

/**
 * The request with add and remove edits applied to the stored tags and
 * validation gaps, so the rest of the update sees whole replacement values.
 */
const withStoredEdits = (
  existing: MemoryRow,
  input: ProductRequest<"update">,
) =>
  Effect.gen(function* () {
    const editsTags =
      input.add_tags !== undefined || input.remove_tags !== undefined;
    const editsGaps =
      input.add_validation_gaps !== undefined ||
      input.remove_validation_gaps !== undefined;
    if (editsTags && input.tags !== undefined) {
      return yield* badRequest(
        "tags replaces the stored tags, so it cannot be combined with add_tags or remove_tags.",
      );
    }
    if (editsGaps && input.validation_gaps !== undefined) {
      return yield* badRequest(
        "validation_gaps replaces the stored gaps, so it cannot be combined with add_validation_gaps or remove_validation_gaps.",
      );
    }
    const gaps = editValidationGaps(existing.validation_gaps, {
      add: input.add_validation_gaps,
      remove: input.remove_validation_gaps,
    });
    if (editsGaps && gaps.error !== undefined) {
      return yield* badRequest(gaps.error);
    }
    return {
      ...input,
      tags: editsTags
        ? editTags(existing.tags, {
            add: input.add_tags,
            remove: input.remove_tags,
          })
        : input.tags,
      validation_gaps: editsGaps ? gaps.gaps : input.validation_gaps,
    };
  });

/** Refusals that depend on the stored row: invalid fields, a stale read, a missing replacement. */
const assertUpdatable = (
  ctx: ApiContext,
  existing: MemoryRow,
  input: ProductRequest<"update">,
  matched: MatchedUpdateTarget | undefined,
) =>
  Effect.gen(function* () {
    const invalid = validateUpdateFields(existing, existing.id, input);
    if (invalid !== undefined) {
      return yield* badRequest(invalid);
    }
    if (matched !== undefined && existing.status !== "active") {
      return yield* conflict("Match is no longer active; retry.");
    }
    if (
      input.expected_update_count !== undefined &&
      input.expected_update_count !== existing.update_count
    ) {
      return yield* conflict(
        `Memory ${existing.id} has update_count ${existing.update_count}, not the expected ${input.expected_update_count}; read it again before updating.`,
      );
    }
    if (
      input.superseded_by !== undefined &&
      !(yield* fetchProductRow(ctx, input.repository, input.superseded_by))
    ) {
      return yield* badRequest(
        "Replacement must exist in the same repository.",
      );
    }
  });

const applyProductUpdate = (
  ctx: ApiContext,
  request: ProductRequest<"update">,
  targetId: number,
  matched: MatchedUpdateTarget | undefined,
) =>
  Effect.gen(function* () {
    const existing = yield* fetchProductRow(ctx, request.repository, targetId);
    if (!existing) {
      return yield* memoryNotFound(ctx, targetId, request.repository);
    }
    const input = yield* withStoredEdits(existing, request);
    yield* assertUpdatable(ctx, existing, input, matched);
    const size = embeddingSizeReport(
      prospectiveUpdateDocument(existing, input),
    );
    if ((input.status ?? existing.status) === "active" && !size.within_budget) {
      return yield* badRequest(embeddingBudgetMessage("Memory", size));
    }
    if (input.content !== undefined) {
      yield* guardReplacement(
        ctx,
        existing,
        input.content,
        input.allow_drop === true,
      );
    }
    return yield* persistProductUpdate(ctx, input, targetId, existing, {
      size,
      matched,
    });
  });

const deprecateProductRows = (
  ctx: ApiContext,
  repository: string,
  ids: readonly number[],
  change: {
    readonly status: "deprecated" | "superseded_by";
    readonly supersededBy: number | null;
    readonly writer: string;
  },
) =>
  Effect.gen(function* () {
    const rows = yield* ctx.d1
      .prepare(
        `UPDATE memories SET status = ?, superseded_by = ?, last_updated_by = ?, updated_at = datetime('now'), update_count = COALESCE(update_count, 0) + 1 WHERE repository = ? AND id IN (SELECT value FROM json_each(?)) RETURNING *`,
      )
      .bind(
        change.status,
        change.supersededBy,
        change.writer,
        repository,
        JSON.stringify(ids),
      )
      .all<JsonObject>();
    const deprecated = rows.results.map(toProductRow);
    const changed = new Set(deprecated.map((row) => row.id));
    const notFoundIds = ids.filter((id) => !changed.has(id));
    return { deprecated, notFound: notFoundIds };
  });

/** Product routes that create, change, or delete memories. */
export const productWriteHandlers = (
  ctx: ApiContext,
): Pick<
  ProductHandlers,
  "add" | "update" | "restore" | "delete" | "delete-many" | "deprecate"
> => ({
  add: (request) =>
    Effect.gen(function* () {
      const input = withCanonicalTags(request);
      const args = normalizeMemoryAddArgs(input);
      const upsertQuery = args.upsert_match?.trim() || undefined;
      if (args.update_id !== undefined) {
        if (upsertQuery !== undefined || args.create_new === true) {
          return yield* badRequest(
            "update_id names the memory to update, so it cannot be combined with upsert_match or create_new.",
          );
        }
        return yield* applyStrongUpsert(ctx, input, args.update_id, undefined);
      }
      if (upsertQuery === undefined) {
        return yield* createProduct(ctx, args, undefined);
      }
      return yield* upsertProductAdd(ctx, input, args, upsertQuery);
    }),

  update: (request) =>
    Effect.gen(function* () {
      const input = withCanonicalTags(request);
      const matchQuery = input.match?.trim() || undefined;
      if (input.id !== undefined && matchQuery !== undefined) {
        return yield* badRequest(
          "Provide either the numeric id or a match query, not both.",
        );
      }
      const target = yield* resolveUpdateTarget(
        ctx,
        input.repository,
        input.id,
        matchQuery,
      );
      return yield* applyProductUpdate(
        ctx,
        input,
        target.targetId,
        target.matched,
      );
    }),

  restore: (input) =>
    // oxlint-disable-next-line max-statements -- restore validates and persists a complete historical row
    Effect.gen(function* () {
      const current = yield* fetchProductRow(ctx, input.repository, input.id);
      if (!current) {
        return yield* memoryNotFound(ctx, input.id, input.repository);
      }
      const snapshot = yield* ctx.sql.unsafe<JsonObject>(
        `SELECT * FROM memory_history WHERE repository = ? AND memory_id = ? AND revision_id = ?`,
        [input.repository, input.id, input.revision_id],
      );
      if (!snapshot[0]) {
        return yield* notFound(
          `No history revision ${input.revision_id} found for memory ${input.id} in repository '${input.repository}'.`,
        );
      }
      const decoded = decodeRequest(StoredMemoryRowSchema, {
        ...snapshot[0],
        id: input.id,
      });
      if (!decoded.ok) {
        return yield* badRequest(
          `The historical memory is not valid under the current schema: ${decoded.error}`,
        );
      }
      const history = normalizeStoredMemoryRow(decoded.value);
      if (current.update_count !== input.expected_update_count) {
        return yield* conflict("Memory changed concurrently; retry.");
      }
      if (
        history.superseded_by !== null &&
        (history.superseded_by === input.id ||
          !(yield* fetchProductRow(
            ctx,
            input.repository,
            history.superseded_by,
          )))
      ) {
        return yield* badRequest(
          "The historical replacement no longer exists in this repository.",
        );
      }
      const size = embeddingSizeReport(history);
      if (history.status === "active" && !size.within_budget) {
        return yield* badRequest(
          embeddingBudgetMessage("The historical memory", size),
        );
      }
      const rowData = yield* ctx.d1
        .prepare(
          `UPDATE memories SET content = ?, tags = ?, context = ?, memory_type = ?, status = ?, superseded_by = ?, source_agent = ?, last_updated_by = 'restore', update_count = COALESCE(update_count, 0) + 1, certainty = ?, refs = ?, expires_after_days = ?, evidence = ?, validation_gaps = ?, created_at = ?, updated_at = datetime('now') WHERE repository = ? AND id = ? AND update_count = ? RETURNING *`,
        )
        .bind(
          history.content,
          history.tags,
          history.context,
          history.memory_type,
          history.status,
          history.superseded_by,
          history.source_agent,
          history.certainty,
          JSON.stringify(history.refs),
          history.expires_after_days,
          JSON.stringify(history.evidence),
          JSON.stringify(history.validation_gaps),
          // Rows leave the database with ISO timestamps; storage keeps SQLite's form.
          history.created_at === null
            ? null
            : sqliteTimestamp(history.created_at),
          input.repository,
          input.id,
          input.expected_update_count,
        )
        .first<JsonObject>();
      if (rowData === null) {
        return yield* conflict("Memory changed concurrently; retry.");
      }
      return {
        written_to: input.repository,
        id: input.id,
        restored_revision_id: input.revision_id,
        memory: toProductRow(rowData),
        size,
      };
    }),

  delete: (input) =>
    Effect.gen(function* () {
      const result = yield* ctx.d1
        .prepare(
          `DELETE FROM memories WHERE repository = ? AND id = ? RETURNING id`,
        )
        .bind(input.repository, input.id)
        .first<{ id: number }>();
      return {
        deleted_from: input.repository,
        id: input.id,
        deleted: result !== null,
        existed: result !== null,
      };
    }),

  "delete-many": (input) =>
    Effect.gen(function* () {
      const requestedIds = [...new Set(input.ids)];
      const rows = yield* ctx.d1
        .prepare(
          `DELETE FROM memories WHERE repository = ? AND id IN (SELECT value FROM json_each(?)) RETURNING id`,
        )
        .bind(input.repository, JSON.stringify(requestedIds))
        .all<{ id: number }>();
      const deleted = new Set(rows.results.map((row) => row.id));
      const deletedIds = requestedIds.filter((id) => deleted.has(id));
      return {
        deleted_from: input.repository,
        requested_ids: requestedIds,
        deleted_ids: deletedIds,
        not_found: requestedIds.filter((id) => !deleted.has(id)),
        count: deletedIds.length,
      };
    }),

  deprecate: (input) =>
    Effect.gen(function* () {
      const requestedIds = [...new Set(input.ids)];
      const supersededBy = input.superseded_by ?? null;
      if (supersededBy !== null && requestedIds.includes(supersededBy)) {
        return yield* badRequest("A memory cannot supersede itself.");
      }
      const status =
        supersededBy === null
          ? ("deprecated" as const)
          : ("superseded_by" as const);
      if (
        supersededBy !== null &&
        !(yield* fetchProductRow(ctx, input.repository, supersededBy))
      ) {
        return yield* badRequest(
          "Replacement must exist in the same repository.",
        );
      }
      const { deprecated, notFound: notFoundIds } = yield* deprecateProductRows(
        ctx,
        input.repository,
        requestedIds,
        { status, supersededBy, writer: writerOf(input.source_agent) },
      );
      const reviewCandidates = yield* fetchReviewCandidates(
        ctx,
        input.repository,
        deprecated.map((row) => ({
          id: row.id,
          memory_type: row.memory_type,
          text: row.content,
        })),
        supersededBy === null ? [] : [supersededBy],
      );
      const result: MemoryDeprecateResult = {
        written_to: input.repository,
        status,
        superseded_by: supersededBy,
        requested_ids: requestedIds,
        deprecated,
        not_found: notFoundIds,
        count: deprecated.length,
      };
      if (reviewCandidates.length > 0) {
        Object.assign(result, { review_candidates: reviewCandidates });
      }
      return result;
    }),
});

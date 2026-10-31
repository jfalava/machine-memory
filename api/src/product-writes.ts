import {
  buildFtsQuery,
  canonicalTags,
  compareMemoryFact,
  decodeRequest,
  droppedDetails,
  embeddingSizeReport,
  evidenceWriteError,
  extractQueryIdentifiers,
  extractTerms,
  hasDroppedDetails,
  normalizeMemoryAddArgs,
  normalizeStoredMemoryRow,
  orderByMatchStrength,
  premiseQuery,
  REVIEW_CANDIDATES_LIMIT,
  reviewsDependents,
  StoredMemoryRowSchema,
  UPSERT_MIN_SIMILARITY,
  type JsonObject,
  type MatchedUpdateTarget,
  type MemoryAddArgs,
  type MemoryDeprecateResult,
  type MemoryRow,
  type MemoryStatus,
  type MemoryType,
  type MemoryWriteResult,
  type ProductRequest,
  type UpsertMatchInfo,
} from "@machine-memory/contract";
import * as Effect from "effect/Effect";

import {
  fetchProductRow,
  fetchRankedProductRows,
  type ApiContext,
  type ProductHandlers,
} from "./api-context";
import {
  badRequest,
  conflict,
  embeddingBudgetError,
  memoryNotFound,
  notFound,
} from "./http-failure";
import {
  INSERT_SQL,
  insertParams,
  updateSets,
  type InsertInput,
} from "./product-api";
import {
  contentHead,
  embeddingTextForMemory,
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

const findBestProductMatch = (
  ctx: ApiContext,
  repository: string,
  query: string,
) =>
  Effect.gen(function* () {
    const terms = extractTerms(query);
    const ftsQuery = buildFtsQuery(terms);
    if (ftsQuery === undefined) {
      return null;
    }
    const rows = yield* fetchRankedProductRows(
      ctx,
      ftsQuery,
      repository,
      { status: "active" },
      5,
    );
    const scored = scoreMemoryRows(rows, {
      terms,
      identifiers: extractQueryIdentifiers(query),
    });
    const best = scored[0];
    if (!best) {
      return null;
    }
    return { row: scoredResultRow(best), score: best.score };
  });

/**
 * Active records that may rely on a changed or retired premise. Literal
 * identifier overlap is decisive; broad term overlap is reported as weak.
 */
const fetchReviewCandidates = (
  ctx: ApiContext,
  repository: string,
  premises: ReadonlyArray<{
    readonly id: number;
    readonly content: string;
    readonly memory_type: MemoryType;
  }>,
  alsoExclude: readonly number[],
) =>
  Effect.gen(function* () {
    const excluded = new Set([
      ...premises.map((premise) => premise.id),
      ...alsoExclude,
    ]);
    const byId = new Map<number, ReturnType<typeof scoredResultRow>>();
    for (const premise of premises) {
      if (!reviewsDependents(premise.memory_type)) {
        continue;
      }
      const query = premiseQuery(premise.content);
      const terms = extractTerms(query.leadingText);
      const ftsQuery = buildFtsQuery(terms);
      if (ftsQuery === undefined) {
        continue;
      }
      const rows = yield* fetchRankedProductRows(
        ctx,
        ftsQuery,
        repository,
        { status: "active" },
        20,
      );
      const scored = scoreMemoryRows(rows, {
        terms,
        identifiers: query.identifiers,
        scope: "files",
      });
      for (const row of scored) {
        if (
          !excluded.has(row.id) &&
          !byId.has(row.id) &&
          row.match_strength !== "none"
        ) {
          byId.set(row.id, scoredResultRow(row));
        }
      }
    }
    return orderByMatchStrength([...byId.values()]).slice(
      0,
      REVIEW_CANDIDATES_LIMIT,
    );
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
      const candidates = yield* fetchReviewCandidates(
        ctx,
        repository,
        [existing],
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

const fetchProductConflicts = (
  ctx: ApiContext,
  insert: InsertInput,
  excludeId: number,
) =>
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
    })
      .filter((candidate) => candidate.id !== excludeId)
      .slice(0, 5)
      .map(scoredResultRow);
  });

/**
 * Inserts a new memory. Without `upsertMatch` the result lists potential
 * conflicts; a forced create after a weak upsert match echoes that match.
 */
const createProduct = (
  ctx: ApiContext,
  args: MemoryAddArgs,
  upsertMatch: UpsertMatchInfo | undefined,
) =>
  Effect.gen(function* () {
    // Every create path checks this: plain adds, unmatched upserts and forced weak matches.
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
    };
    const size = embeddingSizeReport(embeddingTextForMemory(insert));
    if (!size.within_budget) {
      return yield* badRequest(embeddingBudgetError("Document text"));
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
    const conflicts = yield* fetchProductConflicts(ctx, insert, memory.id);
    return { ...result, potential_conflicts: conflicts };
  });

const strongUpsertError = (
  input: ProductRequest<"add">,
  prospective: { memory_type: MemoryType },
  existing: MemoryRow,
): string | undefined =>
  input.expires_after_days !== undefined && prospective.memory_type !== "status"
    ? "expires_after_days is only valid for status memories."
    : evidenceWriteError(input, existing);

/**
 * Updates the strongly matched memory. Unset optional fields keep the stored
 * values, so this reads the raw request rather than defaulted add arguments.
 */
const applyStrongUpsert = (
  ctx: ApiContext,
  input: ProductRequest<"add">,
  info: UpsertMatchInfo,
) =>
  Effect.gen(function* () {
    const existing = yield* fetchProductRow(ctx, input.repository, info.id);
    if (!existing || existing.status !== "active") {
      return yield* conflict("Match changed; retry.");
    }
    const prospective = {
      content: input.content,
      tags: input.tags ?? existing.tags,
      context: input.context ?? existing.context,
      memory_type: input.memory_type ?? existing.memory_type,
      status: existing.status,
      certainty: input.certainty ?? existing.certainty,
    };
    const invalid = strongUpsertError(input, prospective, existing);
    if (invalid !== undefined) {
      return yield* badRequest(invalid);
    }
    const size = embeddingSizeReport(embeddingTextForMemory(prospective));
    if (!size.within_budget) {
      return yield* badRequest(embeddingBudgetError("Document text"));
    }
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
    })!; // Content is required, so updateSets always has a field.
    const rowData = yield* ctx.d1
      .prepare(
        `UPDATE memories SET ${update.sql} WHERE repository = ? AND id = ? AND status = 'active' AND update_count = ? RETURNING *`,
      )
      .bind(...update.params, input.repository, info.id, existing.update_count)
      .first<JsonObject>();
    if (rowData === null) {
      return yield* conflict("Memory changed concurrently; retry.");
    }
    const result: MemoryWriteResult = {
      mode: "updated",
      written_to: input.repository,
      id: info.id,
      memory: toProductRow(rowData),
      size,
      upsert_match: info,
    };
    return result;
  });

const upsertProductAdd = (
  ctx: ApiContext,
  input: ProductRequest<"add">,
  args: MemoryAddArgs,
  upsertQuery: string,
) =>
  Effect.gen(function* () {
    const best = yield* findBestProductMatch(ctx, args.repository, upsertQuery);
    if (!best) {
      return yield* createProduct(ctx, args, undefined);
    }
    const check = compareMemoryFact(
      [best.row.content, best.row.tags, best.row.context].join(" "),
      [args.content, args.tags ?? "", args.context ?? ""].join(" "),
    );
    const strong =
      check.similarity >= UPSERT_MIN_SIMILARITY &&
      best.score >= args.upsert_threshold;
    const info: UpsertMatchInfo = {
      id: best.row.id,
      score: best.score,
      similarity: check.similarity,
      memory_type: best.row.memory_type,
      status: best.row.status,
      content_head: contentHead(best.row.content),
    };
    if (!strong && !args.force) {
      return yield* badRequest(
        `Best match #${info.id} is not a strong upsert match (score ${info.score}, similarity ${info.similarity}; needs score >= ${args.upsert_threshold} AND similarity >= ${UPSERT_MIN_SIMILARITY}). Inspect it with product/get, rerun with force true, or lower upsert_threshold.`,
      );
    }
    if (!strong) {
      return yield* createProduct(ctx, args, info);
    }
    return yield* applyStrongUpsert(ctx, input, info);
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
      const best = yield* findBestProductMatch(ctx, repository, match);
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

/** Embedding text of the memory as it would be after the update. */
const prospectiveUpdateText = (
  existing: MemoryRow,
  input: ProductRequest<"update">,
) =>
  embeddingTextForMemory({
    content: input.content ?? existing.content,
    tags: input.tags ?? existing.tags,
    context: input.context ?? existing.context,
    memory_type: input.memory_type ?? existing.memory_type,
    status: input.status ?? existing.status,
    certainty: input.certainty ?? existing.certainty,
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

const applyProductUpdate = (
  ctx: ApiContext,
  input: ProductRequest<"update">,
  targetId: number,
  matched: MatchedUpdateTarget | undefined,
) =>
  Effect.gen(function* () {
    const existing = yield* fetchProductRow(ctx, input.repository, targetId);
    if (!existing) {
      return yield* memoryNotFound(targetId, input.repository);
    }
    const invalid = validateUpdateFields(existing, targetId, input);
    if (invalid !== undefined) {
      return yield* badRequest(invalid);
    }
    if (matched !== undefined && existing.status !== "active") {
      return yield* conflict("Match is no longer active; retry.");
    }
    if (
      input.superseded_by !== undefined &&
      !(yield* fetchProductRow(ctx, input.repository, input.superseded_by))
    ) {
      return yield* badRequest(
        "Replacement must exist in the same repository.",
      );
    }
    const size = embeddingSizeReport(prospectiveUpdateText(existing, input));
    if ((input.status ?? existing.status) === "active" && !size.within_budget) {
      return yield* badRequest(embeddingBudgetError("Document text"));
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
  status: "deprecated" | "superseded_by",
  supersededBy: number | null,
) =>
  Effect.gen(function* () {
    const rows = yield* ctx.d1
      .prepare(
        `UPDATE memories SET status = ?, superseded_by = ?, last_updated_by = 'api', updated_at = datetime('now'), update_count = COALESCE(update_count, 0) + 1 WHERE repository = ? AND id IN (SELECT value FROM json_each(?)) RETURNING *`,
      )
      .bind(status, supersededBy, repository, JSON.stringify(ids))
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
  add: (request) => {
    const input = withCanonicalTags(request);
    const args = normalizeMemoryAddArgs(input);
    const upsertQuery = args.upsert_match?.trim() || undefined;
    if (upsertQuery === undefined) {
      return createProduct(ctx, args, undefined);
    }
    return upsertProductAdd(ctx, input, args, upsertQuery);
  },

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
        return yield* memoryNotFound(input.id, input.repository);
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
      const size = embeddingSizeReport(embeddingTextForMemory(history));
      if (history.status === "active" && !size.within_budget) {
        return yield* badRequest(
          "The historical memory exceeds the current embedding budget.",
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
          history.created_at,
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
        status,
        supersededBy,
      );
      const reviewCandidates = yield* fetchReviewCandidates(
        ctx,
        input.repository,
        deprecated,
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

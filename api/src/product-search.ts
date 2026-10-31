import {
  buildFtsQuery,
  deriveFileNeighborhood,
  embeddingSizeReport,
  extractPathTerms,
  extractQueryIdentifiers,
  extractTerms,
  fileIdentifiers,
  FTS_CANDIDATE_LIMIT,
  hasStrongMatch,
  mergeSuggestCandidates,
  normalizeMemoryQueryArgs,
  normalizeMemorySuggestArgs,
  orderByMatchStrength,
  reciprocalRankScore,
  semanticCandidateCount,
  type JsonObject,
  type MemoryQueryArgs,
} from "@machine-memory/contract";
import * as Effect from "effect/Effect";

import {
  fetchProductRow,
  fetchRankedProductRows,
  type ApiContext,
  type ProductHandlers,
} from "./api-context";
import { badRequest, embeddingBudgetError } from "./http-failure";
import { neighborhoodSelect } from "./product-api";
import {
  assessRowMatch,
  parseSuggestFilesParam,
  scoredResultRow,
  scoreMemoryRows,
  strongerMatch,
  toRankedRow,
  uniqueLowerPreserveOrder,
  type MatchQuery,
} from "./product-logic";
import { searchVectors } from "./vector-search";

type ScoredResult = ReturnType<typeof scoredResultRow>;

const fetchKeywordScored = (
  ctx: ApiContext,
  args: MemoryQueryArgs,
  ftsQuery: string,
  limit: number,
  match: MatchQuery,
) =>
  Effect.gen(function* () {
    const rows = yield* fetchRankedProductRows(
      ctx,
      ftsQuery,
      args.repository,
      args,
      FTS_CANDIDATE_LIMIT,
    );
    return scoreMemoryRows(rows, match).slice(0, limit).map(scoredResultRow);
  });

const resolveSemanticMatch = (
  ctx: ApiContext,
  args: MemoryQueryArgs,
  match: { id: string; score: number },
  query: MatchQuery,
) =>
  Effect.gen(function* () {
    const id = Number(match.id);
    if (!Number.isInteger(id)) {
      return undefined;
    }
    const row = yield* fetchProductRow(ctx, args.repository, id);
    if (!row) {
      return undefined;
    }
    if (
      (args.status !== undefined && row.status !== args.status) ||
      (args.memory_type !== undefined &&
        row.memory_type !== args.memory_type) ||
      (args.certainty !== undefined && row.certainty !== args.certainty) ||
      (args.tags !== undefined &&
        !row.tags.toLowerCase().includes(args.tags.toLowerCase()))
    ) {
      return undefined;
    }
    return scoredResultRow({
      ...row,
      ...assessRowMatch(row, query, match.score),
      score: match.score,
    });
  });

const fetchSemanticScored = (
  ctx: ApiContext,
  args: MemoryQueryArgs,
  match: MatchQuery,
) =>
  Effect.gen(function* () {
    const { matches } = yield* searchVectors(
      ctx,
      args.query,
      args.repository,
      semanticCandidateCount(args.limit),
      args,
    );
    const collected: ScoredResult[] = [];
    for (const candidate of matches) {
      const row = yield* resolveSemanticMatch(ctx, args, candidate, match);
      if (row) {
        collected.push(row);
      }
    }
    return collected;
  });

const keywordResults = (ctx: ApiContext, args: MemoryQueryArgs) =>
  Effect.gen(function* () {
    const terms = extractTerms(args.query);
    const ftsQuery = buildFtsQuery(terms);
    if (ftsQuery === undefined) {
      return [];
    }
    return yield* fetchKeywordScored(ctx, args, ftsQuery, args.limit, {
      terms,
      identifiers: extractQueryIdentifiers(args.query),
    });
  });

const semanticResults = (ctx: ApiContext, args: MemoryQueryArgs) =>
  Effect.gen(function* () {
    const results = yield* fetchSemanticScored(ctx, args, {
      terms: extractTerms(args.query),
      identifiers: extractQueryIdentifiers(args.query),
    });
    return orderByMatchStrength(results).slice(0, args.limit);
  });

const hybridResults = (ctx: ApiContext, args: MemoryQueryArgs) =>
  Effect.gen(function* () {
    const terms = extractTerms(args.query);
    const match = {
      terms,
      identifiers: extractQueryIdentifiers(args.query),
    };
    const ftsQuery = buildFtsQuery(terms);
    const keyword =
      ftsQuery === undefined
        ? []
        : yield* fetchKeywordScored(
            ctx,
            args,
            ftsQuery,
            FTS_CANDIDATE_LIMIT,
            match,
          );
    const semantic = yield* fetchSemanticScored(ctx, args, match);
    // Reciprocal-rank fusion compares ranks rather than unrelated lexical
    // and cosine score scales. Overlapping results receive both contributions.
    const byId = new Map<number, ScoredResult>();
    for (const list of [keyword, semantic]) {
      for (const [rank, row] of list.entries()) {
        const previous = byId.get(row.id);
        byId.set(row.id, {
          ...row,
          ...(previous ? strongerMatch(previous, row) : row),
          score: (previous?.score ?? 0) + reciprocalRankScore(rank),
        });
      }
    }
    return orderByMatchStrength(
      [...byId.values()].sort((a, b) => b.score - a.score || a.id - b.id),
    ).slice(0, args.limit);
  });

const searchResults = (ctx: ApiContext, args: MemoryQueryArgs) =>
  Effect.gen(function* () {
    if (args.mode === "keyword") {
      return yield* keywordResults(ctx, args);
    }
    if (!embeddingSizeReport(args.query).within_budget) {
      return yield* badRequest(embeddingBudgetError("Query"));
    }
    if (args.mode === "semantic") {
      return yield* semanticResults(ctx, args);
    }
    return yield* hybridResults(ctx, args);
  });

/** Product routes that rank memories for a query or a set of files. */
export const productSearchHandlers = (
  ctx: ApiContext,
): Pick<ProductHandlers, "query" | "suggest"> => ({
  query: (input) =>
    Effect.gen(function* () {
      const results = yield* searchResults(
        ctx,
        normalizeMemoryQueryArgs(input),
      );
      return {
        count: results.length,
        no_strong_match: !hasStrongMatch(results),
        results,
      };
    }),

  suggest: (input) =>
    Effect.gen(function* () {
      const args = normalizeMemorySuggestArgs(input);
      const files = parseSuggestFilesParam(args.files);
      if (files.length === 0) {
        return yield* badRequest(
          "Provide at least one file path in files, e.g. 'src/auth/jwt.ts,src/middleware/session.ts'.",
        );
      }
      const pathTerms = extractPathTerms(files);
      const neighborhood = deriveFileNeighborhood(files);
      const queryTerms = args.query ? extractTerms(args.query) : [];
      const scoreTerms = uniqueLowerPreserveOrder([
        ...pathTerms,
        ...neighborhood.terms,
        ...queryTerms,
      ]);
      const ftsQuery = buildFtsQuery(
        uniqueLowerPreserveOrder([...pathTerms, ...queryTerms]),
      );
      const ftsRows =
        ftsQuery === undefined
          ? []
          : yield* fetchRankedProductRows(
              ctx,
              ftsQuery,
              args.repository,
              args,
              FTS_CANDIDATE_LIMIT,
            );
      const select = neighborhoodSelect({
        repository: args.repository,
        filters: args,
        tagHints: neighborhood.tagHints,
        pathHints: neighborhood.pathHints,
      });
      const neighborhoodRows =
        select === undefined
          ? []
          : (yield* ctx.sql.unsafe<JsonObject>(select.sql, select.params)).map(
              toRankedRow,
            );
      const match = {
        terms: scoreTerms,
        identifiers: fileIdentifiers(files),
        scope: "files" as const,
      };
      const results = orderByMatchStrength(
        mergeSuggestCandidates(
          scoreMemoryRows(ftsRows, match),
          scoreMemoryRows(neighborhoodRows, match),
        ),
      )
        .slice(0, args.limit)
        .map(scoredResultRow);
      return {
        files,
        normalized_path_terms: pathTerms,
        derived_terms: scoreTerms,
        neighborhood: {
          tags: neighborhood.tagHints,
          paths: neighborhood.pathHints,
        },
        count: results.length,
        no_strong_match: !hasStrongMatch(results),
        results,
      };
    }),
});

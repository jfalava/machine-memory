import { Effect } from "effect";
import { getFlagValue, hasFlag, printJson, usageError } from "../../cli-utils";
import type { MemoryDatabaseError } from "../../effect/database";
import {
  HYBRID_SCORE_WEIGHTS,
  SCORE_COMPONENT_WEIGHTS,
  applySqlFilters,
  buildFtsQueryFromTerms,
  combineHybridResults,
  deriveNeighborhoodFromFiles,
  extractPathTermsFromFiles,
  extractTerms,
  mergeSuggestionResults,
  minimalResultSummary,
  normalizeSqliteRow,
  parseCommonFilters,
  parseResultLimit,
  parseSuggestFiles,
  printBriefLines,
  queryEmptyResultPayload,
  queryNeighborhoodMatches,
  shapeRowsWithScore,
  sortByScoreThenRecency,
  uniqueLowerPreserveOrder,
} from "../shared";
import { repositoryForCurrentDirectory } from "../../repository";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";

const SWEEP_USAGE =
  'sweep (--files "src/a.ts,src/b.ts" | --files-json \'["src/a.ts","src/b.ts"]\') [--query <search_term>] [--tags <tag>] [--limit <n>] [--brief|--json-min|--quiet]';
const MAX_SEMANTIC_LIMIT = 50;

type FetchResultsOptions = {
  explainScore: boolean;
  limit?: number;
};

type QueryResults = {
  results: Record<string, unknown>[];
  queryTokens: string[];
  filters: ReturnType<typeof parseCommonFilters>;
};

type SuggestSnapshot = {
  files: string[];
  normalizedPathTerms: string[];
  suggestTerms: string[];
  neighborhood: ReturnType<typeof deriveNeighborhoodFromFiles>;
  filters: ReturnType<typeof parseCommonFilters>;
  ftsQuery: string | undefined;
};

type SweepSource = "suggest" | "query" | "list";

function explainScoreEnabled(args: string[]): boolean {
  return hasFlag(args, "--explain-score");
}

function resultIds(results: Record<string, unknown>[]): unknown[] {
  return results.map((entry) => entry.id);
}

function minimalScoredResultSummary(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const summary = minimalResultSummary(row);
  for (const component of ["fts_score", "semantic_score", "hybrid_score"]) {
    if (typeof row[component] === "number") {
      summary[component] = row[component];
    }
  }
  return summary;
}

function printScoredResults(
  commandCtx: Pick<CommandContext, "command" | "outputMode">,
  results: Record<string, unknown>[],
  options: {
    explainScore: boolean;
    semantic?: boolean;
    scoreWeights?: Record<string, unknown>;
    wrapResults?: boolean;
  },
) {
  const { outputMode } = commandCtx;
  const showScoreWeights =
    options.explainScore && options.scoreWeights !== undefined;
  if (outputMode.jsonMin || outputMode.quiet) {
    const payload: Record<string, unknown> = {
      count: results.length,
      ids: resultIds(results),
    };
    if (outputMode.jsonMin) {
      payload.results = results.map(minimalScoredResultSummary);
    }
    if (showScoreWeights) {
      payload.score_weights = options.scoreWeights;
    }
    printJson(payload);
    return;
  }
  if (outputMode.brief) {
    printBriefLines(results);
    return;
  }
  if (options.wrapResults) {
    printCommandOutput(commandCtx, {
      results,
      ...(showScoreWeights ? { score_weights: options.scoreWeights } : {}),
    });
    return;
  }
  printCommandOutput(commandCtx, results);
}

function printEmptyQueryResults(
  commandCtx: Pick<CommandContext, "command" | "outputMode">,
  term: string,
  filters: ReturnType<typeof parseCommonFilters>,
  queryTokens: string[],
) {
  const { outputMode } = commandCtx;
  if (outputMode.brief) {
    printBriefLines([]);
    return;
  }
  printCommandOutput(
    commandCtx,
    queryEmptyResultPayload(term, filters, queryTokens),
  );
}

function fetchQueryResults(
  commandCtx: CommandContext,
  term: string,
  options: FetchResultsOptions,
): Effect.Effect<QueryResults, MemoryDatabaseError> {
  const { args } = commandCtx;
  const database = requireDatabase(commandCtx);
  const filters = parseCommonFilters(args);
  const queryTokens = extractTerms([term, filters.tag ?? ""].join(" "));
  const ftsQuery = buildFtsQueryFromTerms(queryTokens);
  if (!ftsQuery) {
    return Effect.succeed({ results: [], queryTokens, filters });
  }

  const clauses = ["memories_fts MATCH ?"];
  const params: (string | number)[] = [ftsQuery];
  applySqlFilters(clauses, params, filters, {
    defaultActiveOnly: true,
    columnPrefix: "m.",
  });

  return database
    .all(
      `SELECT m.*, bm25(memories_fts) AS fts_rank
       FROM memories m
       JOIN memories_fts ON m.id = memories_fts.rowid
       WHERE ${clauses.join(" AND ")}
       ORDER BY bm25(memories_fts)
       LIMIT 100`,
      params,
    )
    .pipe(
      Effect.map((rows) => ({
        results: shapeRowsWithScore(rows, queryTokens, {
          explainScore: options.explainScore,
        }).slice(0, options.limit ?? 8),
        queryTokens,
        filters,
      })),
    );
}

function fetchSemanticCandidates(
  commandCtx: CommandContext,
  term: string,
  options: {
    limit: number;
    topKMultiplier: number;
    minimumTopK?: number;
  },
): Effect.Effect<QueryResults, MemoryDatabaseError> {
  const database = requireDatabase(commandCtx);
  const vectorize = database.vectorize;
  if (!vectorize) {
    usageError("Semantic search requires the remote backend: query --remote.");
  }
  if (options.limit > MAX_SEMANTIC_LIMIT) {
    usageError(
      `--limit must be an integer between 1 and ${MAX_SEMANTIC_LIMIT} for semantic and hybrid search.`,
    );
  }
  const topK = Math.min(
    MAX_SEMANTIC_LIMIT,
    Math.max(
      options.limit * options.topKMultiplier,
      options.minimumTopK ?? options.limit,
    ),
  );

  const filters = parseCommonFilters(commandCtx.args);
  const queryTokens = extractTerms([term, filters.tag ?? ""].join(" "));
  const status =
    filters.status ?? (filters.includeDeprecated ? undefined : "active");

  return vectorize
    .search({
      repository: repositoryForCurrentDirectory(),
      query: term,
      top_k: topK,
      ...(status ? { status } : {}),
      ...(filters.memoryType ? { memory_type: filters.memoryType } : {}),
      ...(filters.certainty ? { certainty: filters.certainty } : {}),
    })
    .pipe(
      Effect.flatMap((searchResult) =>
        Effect.gen(function* () {
          const validIds = searchResult.matches
            .map((match) => Number(match.id))
            .filter((id) => Number.isInteger(id));
          if (validIds.length === 0) {
            return { results: [], queryTokens, filters };
          }

          const rows = yield* database.all(
            `SELECT * FROM memories
             WHERE repository = ? AND id IN (${validIds.map(() => "?").join(", ")})`,
            [repositoryForCurrentDirectory(), ...validIds],
          );
          const rowsById = new Map(
            rows.map((row) => {
              const normalized = normalizeSqliteRow(row);
              return [Number(normalized.id), normalized] as const;
            }),
          );
          const results: Record<string, unknown>[] = [];
          for (const match of searchResult.matches) {
            const id = Number(match.id);
            if (!Number.isInteger(id)) {
              continue;
            }
            const row = rowsById.get(id);
            if (!row) {
              continue;
            }
            if (
              filters.tag &&
              !(typeof row.tags === "string" ? row.tags : "")
                .toLowerCase()
                .includes(filters.tag.toLowerCase())
            ) {
              continue;
            }
            results.push({
              ...row,
              score: match.score,
              semantic_score: match.score,
            });
          }
          return { results, queryTokens, filters };
        }),
      ),
    );
}

function fetchSemanticResults(
  commandCtx: CommandContext,
  term: string,
  options: FetchResultsOptions,
): Effect.Effect<QueryResults, MemoryDatabaseError> {
  const limit = options.limit ?? 8;
  return fetchSemanticCandidates(commandCtx, term, {
    limit,
    topKMultiplier: 3,
  }).pipe(
    Effect.map((result) => ({
      ...result,
      results: result.results.slice(0, limit),
    })),
  );
}

function fetchHybridResults(
  commandCtx: CommandContext,
  term: string,
  options: FetchResultsOptions,
): Effect.Effect<QueryResults, MemoryDatabaseError> {
  const limit = options.limit ?? 8;
  return Effect.all(
    [
      fetchQueryResults(commandCtx, term, {
        explainScore: options.explainScore,
        limit: 100,
      }),
      fetchSemanticCandidates(commandCtx, term, {
        limit,
        topKMultiplier: 4,
        minimumTopK: 12,
      }),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([fts, semantic]) => ({
      results: combineHybridResults(
        fts.results,
        semantic.results,
        limit,
        options.explainScore,
      ),
      queryTokens: fts.queryTokens,
      filters: fts.filters,
    })),
  );
}

export function handleQueryCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args } = commandCtx;
    const term = args[0];
    if (!term) {
      usageError("Usage: query <search_term>");
    }
    const explainScore = explainScoreEnabled(args);
    const semantic = hasFlag(args, "--semantic");
    const hybrid = hasFlag(args, "--hybrid");
    if (semantic && hybrid) {
      usageError("Use either --semantic or --hybrid, not both.");
    }
    const fetchResults = hybrid
      ? fetchHybridResults
      : semantic
        ? fetchSemanticResults
        : fetchQueryResults;
    const { results, queryTokens, filters } = yield* fetchResults(
      commandCtx,
      term,
      {
        explainScore,
        limit: parseResultLimit(args),
      },
    );
    yield* Effect.sync(() => {
      if (results.length === 0) {
        printEmptyQueryResults(commandCtx, term, filters, queryTokens);
        return;
      }
      printScoredResults(commandCtx, results, {
        explainScore,
        semantic,
        scoreWeights: hybrid
          ? HYBRID_SCORE_WEIGHTS
          : semantic
            ? undefined
            : SCORE_COMPONENT_WEIGHTS,
        wrapResults: explainScore,
      });
    });
  });
}

export function handleListCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args, outputMode } = commandCtx;
    const database = requireDatabase(commandCtx);
    const filters = parseCommonFilters(args);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    applySqlFilters(clauses, params, filters, { defaultActiveOnly: true });
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = yield* database.all(
      `SELECT * FROM memories ${where} ORDER BY updated_at DESC, id DESC LIMIT 100`,
      params,
    );
    const normalized = rows
      .map((row) => normalizeSqliteRow(row))
      .slice(0, parseResultLimit(args, 100));
    yield* Effect.sync(() => {
      if (outputMode.jsonMin || outputMode.quiet) {
        const payload: Record<string, unknown> = {
          count: normalized.length,
          ids: resultIds(normalized),
        };
        if (outputMode.jsonMin) {
          payload.results = normalized.map(minimalResultSummary);
        }
        printJson(payload);
        return;
      }
      if (outputMode.brief) {
        printBriefLines(normalized);
        return;
      }
      printCommandOutput(commandCtx, normalized);
    });
  });
}

function buildSuggestSnapshot(args: string[]): SuggestSnapshot {
  const files = parseSuggestFiles(args);
  const normalizedPathTerms = extractPathTermsFromFiles(files);
  const neighborhood = deriveNeighborhoodFromFiles(files);
  const suggestTerms = uniqueLowerPreserveOrder([
    ...normalizedPathTerms,
    ...neighborhood.terms,
  ]);
  return {
    files,
    normalizedPathTerms,
    suggestTerms,
    neighborhood,
    filters: parseCommonFilters(args),
    ftsQuery: buildFtsQueryFromTerms(normalizedPathTerms),
  };
}

function fetchFtsSuggestResults(
  commandCtx: CommandContext,
  snapshot: SuggestSnapshot,
  options: FetchResultsOptions,
): Effect.Effect<Record<string, unknown>[], MemoryDatabaseError> {
  if (snapshot.ftsQuery === undefined) {
    return Effect.succeed([]);
  }
  const ftsClauses = ["memories_fts MATCH ?"];
  const ftsParams: (string | number)[] = [snapshot.ftsQuery];
  applySqlFilters(ftsClauses, ftsParams, snapshot.filters, {
    defaultActiveOnly: true,
    columnPrefix: "m.",
  });
  return requireDatabase(commandCtx)
    .all(
      `SELECT m.*, bm25(memories_fts) AS fts_rank
       FROM memories m
       JOIN memories_fts ON m.id = memories_fts.rowid
       WHERE ${ftsClauses.join(" AND ")}
       ORDER BY bm25(memories_fts)
       LIMIT 100`,
      ftsParams,
    )
    .pipe(
      Effect.map((rows) =>
        shapeRowsWithScore(rows, snapshot.suggestTerms, {
          explainScore: options.explainScore,
        }).slice(0, options.limit ?? 8),
      ),
    );
}

function collectSuggestResults(
  commandCtx: CommandContext,
  snapshot: SuggestSnapshot,
  options: FetchResultsOptions,
): Effect.Effect<Record<string, unknown>[], MemoryDatabaseError> {
  return Effect.gen(function* () {
    const neighborhoodResults = yield* queryNeighborhoodMatches(
      requireDatabase(commandCtx),
      snapshot.neighborhood,
      snapshot.filters,
      options.limit ?? 8,
    );
    const ftsResults = yield* fetchFtsSuggestResults(
      commandCtx,
      snapshot,
      options,
    );
    return mergeSuggestionResults(ftsResults, neighborhoodResults).slice(
      0,
      options.limit ?? 8,
    );
  });
}

function printSuggestResults(
  commandCtx: CommandContext,
  snapshot: SuggestSnapshot,
  results: Record<string, unknown>[],
  options: FetchResultsOptions,
) {
  const { outputMode } = commandCtx;
  if (outputMode.jsonMin || outputMode.quiet) {
    const payload: Record<string, unknown> = {
      count: results.length,
      ids: resultIds(results),
    };
    if (outputMode.jsonMin) {
      payload.results = results.map(minimalResultSummary);
    }
    if (options.explainScore) {
      payload.score_weights = SCORE_COMPONENT_WEIGHTS;
    }
    printJson(payload);
    return;
  }
  if (outputMode.brief) {
    printBriefLines(results);
    return;
  }

  printCommandOutput(commandCtx, {
    files: snapshot.files,
    normalized_files: snapshot.files,
    normalized_path_terms: snapshot.normalizedPathTerms,
    derived_terms: snapshot.suggestTerms,
    neighborhood: {
      tags: snapshot.neighborhood.tagHints,
      paths: snapshot.neighborhood.pathHints,
    },
    ...(options.explainScore ? { score_weights: SCORE_COMPONENT_WEIGHTS } : {}),
    results,
  });
}

export function handleSuggestCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const explainScore = explainScoreEnabled(commandCtx.args);
    const snapshot = buildSuggestSnapshot(commandCtx.args);
    const results = yield* collectSuggestResults(commandCtx, snapshot, {
      explainScore,
      limit: parseResultLimit(commandCtx.args),
    });
    yield* Effect.sync(() =>
      printSuggestResults(commandCtx, snapshot, results, { explainScore }),
    );
  });
}

function ensureSweepFileArgs(args: string[]) {
  const filesRaw = getFlagValue(args, "--files");
  const filesJsonRaw = getFlagValue(args, "--files-json");
  if (!filesRaw && !filesJsonRaw) {
    usageError(`Usage: ${SWEEP_USAGE}`);
  }
  if (filesRaw && filesJsonRaw) {
    usageError("Use either --files or --files-json, not both.");
  }
}

function parseSweepQueryArg(args: string[]): string | undefined {
  const value = getFlagValue(args, "--query");
  if (hasFlag(args, "--query") && value === undefined) {
    usageError(`Usage: ${SWEEP_USAGE}`);
  }
  return value;
}

function fetchListScoredResults(
  commandCtx: CommandContext,
  scoreTerms: string[],
  options: FetchResultsOptions,
): Effect.Effect<
  {
    results: Record<string, unknown>[];
    filters: ReturnType<typeof parseCommonFilters>;
  },
  MemoryDatabaseError
> {
  const filters = parseCommonFilters(commandCtx.args);
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  applySqlFilters(clauses, params, filters, {
    defaultActiveOnly: true,
    columnPrefix: "m.",
  });
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return requireDatabase(commandCtx)
    .all(
      `SELECT m.*, 0 AS fts_rank
       FROM memories m
       ${where}
       ORDER BY m.updated_at DESC, m.id DESC
       LIMIT 100`,
      params,
    )
    .pipe(
      Effect.map((rows) => ({
        results: shapeRowsWithScore(rows, scoreTerms, {
          explainScore: options.explainScore,
        }).slice(0, options.limit ?? 8),
        filters,
      })),
    );
}

function mergeSweepRows(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  source: SweepSource,
): Record<string, unknown> {
  const currentSources = Array.isArray(left.sources)
    ? (left.sources as SweepSource[])
    : [];
  const nextSources = currentSources.includes(source)
    ? currentSources
    : [...currentSources, source];
  const leftScore = Number(left.score ?? 0);
  const rightScore = Number(right.score ?? 0);
  const base = rightScore > leftScore ? right : left;
  return {
    ...base,
    score: Number(Math.max(leftScore, rightScore).toFixed(3)),
    sources: nextSources,
  };
}

function mergeSweepResults(
  parts: { source: SweepSource; rows: Record<string, unknown>[] }[],
): Record<string, unknown>[] {
  const byId = new Map<number, Record<string, unknown>>();
  for (const part of parts) {
    for (const row of part.rows) {
      const id = Number(row.id);
      if (!Number.isInteger(id) || id <= 0) {
        continue;
      }
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, { ...row, sources: [part.source] });
        continue;
      }
      byId.set(id, mergeSweepRows(existing, row, part.source));
    }
  }
  return sortByScoreThenRecency([...byId.values()]);
}

export function handleSweepCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args, outputMode } = commandCtx;
    ensureSweepFileArgs(args);
    const queryTerm = parseSweepQueryArg(args);
    const explainScore = explainScoreEnabled(args);
    const limit = parseResultLimit(args);
    const snapshot = buildSuggestSnapshot(args);
    const suggestResults = yield* collectSuggestResults(commandCtx, snapshot, {
      explainScore,
      limit,
    });
    const queryBundle = queryTerm
      ? yield* fetchQueryResults(commandCtx, queryTerm, { explainScore, limit })
      : {
          results: [],
          queryTokens: [] as string[],
          filters: parseCommonFilters(args),
        };
    const listScoreTerms = uniqueLowerPreserveOrder([
      ...snapshot.suggestTerms,
      ...queryBundle.queryTokens,
      ...extractTerms(queryBundle.filters.tag ?? ""),
    ]);
    const listBundle = yield* fetchListScoredResults(
      commandCtx,
      listScoreTerms,
      {
        explainScore,
        limit,
      },
    );
    const results = mergeSweepResults([
      { source: "suggest", rows: suggestResults },
      { source: "query", rows: queryBundle.results },
      { source: "list", rows: listBundle.results },
    ]).slice(0, limit);
    yield* Effect.sync(() => {
      if (outputMode.jsonMin || outputMode.quiet) {
        const payload: Record<string, unknown> = {
          count: results.length,
          ids: resultIds(results),
        };
        if (outputMode.jsonMin) {
          payload.results = results.map((row) => ({
            ...minimalResultSummary(row),
            sources: row.sources,
          }));
        }
        if (explainScore) {
          payload.score_weights = SCORE_COMPONENT_WEIGHTS;
        }
        printJson(payload);
        return;
      }
      if (outputMode.brief) {
        printBriefLines(results);
        return;
      }
      printCommandOutput(commandCtx, {
        files: snapshot.files,
        normalized_files: snapshot.files,
        normalized_path_terms: snapshot.normalizedPathTerms,
        derived_terms: snapshot.suggestTerms,
        query: queryTerm ?? null,
        filters: { tags: listBundle.filters.tag ?? null },
        ...(explainScore ? { score_weights: SCORE_COMPONENT_WEIGHTS } : {}),
        results,
      });
    });
  });
}

import {
  FTS_CANDIDATE_LIMIT,
  SEARCH_LIMIT_MAX,
  SEARCH_SCORE_WEIGHTS,
  buildFtsQuery,
  deriveFileNeighborhood,
  extractPathTerms,
  extractQueryIdentifiers,
  extractTerms,
  fileIdentifiers,
  semanticCandidateCount,
  type FileNeighborhood,
} from "@machine-memory/contract";
import { Effect } from "effect";

import { getFlagValue, hasFlag, printJson, usageError } from "../../cli-utils";
import type { MemoryDatabaseError } from "../../effect/database";
import { jsonNumber, type JsonObject } from "../../json";
import { repositoryForCurrentDirectory } from "../../repository";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";
import {
  HYBRID_FUSION,
  annotateMatches,
  applySqlFilters,
  combineHybridResults,
  hasStrongMatchRow,
  mergeSuggestionResults,
  minimalResultSummary,
  orderRowsByMatchStrength,
  normalizeSqliteRow,
  parseCommonFilters,
  parseResultLimit,
  parseSuggestFiles,
  printBriefLines,
  queryEmptyResultPayload,
  queryNeighborhoodMatches,
  scoreRowsWithDetails,
  sortByScoreThenRecency,
  stringValue,
  uniqueLowerPreserveOrder,
  type SearchMatchQuery,
} from "../shared";

const SWEEP_USAGE =
  'sweep (--files "src/a.ts,src/b.ts" | --files-json \'["src/a.ts","src/b.ts"]\') [--query <search_term>] [--tags <tag>] [--limit <n>] [--brief|--json-min|--quiet]';

type FetchResultsOptions = {
  explainScore: boolean;
  limit?: number;
};

type QueryResults = {
  results: JsonObject[];
  queryTokens: string[];
  filters: ReturnType<typeof parseCommonFilters>;
};

type SuggestSnapshot = {
  files: string[];
  normalizedPathTerms: string[];
  suggestTerms: string[];
  neighborhood: FileNeighborhood;
  filters: ReturnType<typeof parseCommonFilters>;
  ftsQuery: string | undefined;
};

type SweepSource = "suggest" | "query" | "list";

function explainScoreEnabled(args: string[]): boolean {
  return hasFlag(args, "--explain-score");
}

function resultIds(results: JsonObject[]): JsonObject["id"][] {
  return results.map((entry) => entry.id);
}

function minimalScoredResultSummary(row: JsonObject): JsonObject {
  const summary = minimalResultSummary(row);
  for (const component of [
    "fts_score",
    "semantic_score",
    "hybrid_score",
    "term_coverage",
  ]) {
    const score = jsonNumber(row[component]);
    if (score !== undefined) {
      summary[component] = score;
    }
  }
  return summary;
}

function minimalScoredPayload(
  results: JsonObject[],
  options: {
    jsonMin: boolean;
    scoreWeights?: JsonObject;
    summarize?: (row: JsonObject) => JsonObject;
  },
): JsonObject {
  const payload: JsonObject = {
    count: results.length,
    no_strong_match: !hasStrongMatchRow(results),
    ids: resultIds(results),
  };
  if (options.jsonMin) {
    payload.results = results.map(
      options.summarize ?? minimalScoredResultSummary,
    );
  }
  if (options.scoreWeights !== undefined) {
    payload.score_weights = options.scoreWeights;
  }
  return payload;
}

function printScoredResults(
  commandCtx: Pick<CommandContext, "command" | "outputMode">,
  results: JsonObject[],
  options: {
    explainScore: boolean;
    semantic?: boolean;
    scoreWeights?: JsonObject;
    wrapResults?: boolean;
  },
) {
  const { outputMode } = commandCtx;
  const showScoreWeights =
    options.explainScore && options.scoreWeights !== undefined;
  if (outputMode.jsonMin || outputMode.quiet) {
    printJson(
      minimalScoredPayload(results, {
        jsonMin: outputMode.jsonMin,
        scoreWeights: showScoreWeights ? options.scoreWeights : undefined,
      }),
    );
    return;
  }
  if (outputMode.brief) {
    printBriefLines(results);
    return;
  }
  if (options.wrapResults) {
    const output = {
      no_strong_match: !hasStrongMatchRow(results),
      results,
    } satisfies JsonObject;
    if (showScoreWeights) {
      Object.assign(output, { score_weights: options.scoreWeights });
    }
    printCommandOutput(commandCtx, output);
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

function termMatchQuery(term: string): SearchMatchQuery {
  return {
    terms: extractTerms(term),
    identifiers: extractQueryIdentifiers(term),
  };
}

function suggestMatchQuery(snapshot: SuggestSnapshot): SearchMatchQuery {
  return {
    terms: snapshot.suggestTerms,
    identifiers: fileIdentifiers(snapshot.files),
    scope: "files",
  };
}

export function fetchQueryResults(
  commandCtx: CommandContext,
  term: string,
  options: FetchResultsOptions,
): Effect.Effect<QueryResults, MemoryDatabaseError> {
  const { args } = commandCtx;
  const database = requireDatabase(commandCtx);
  const filters = parseCommonFilters(args);
  const queryTokens = extractTerms([term, filters.tag ?? ""].join(" "));
  const ftsQuery = buildFtsQuery(queryTokens);
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
        results: scoreRowsWithDetails(rows, queryTokens, {
          explainScore: options.explainScore,
          identifiers: extractQueryIdentifiers(term),
        }).slice(0, options.limit ?? 8),
        queryTokens,
        filters,
      })),
    );
}

function fetchSemanticCandidates(
  commandCtx: CommandContext,
  term: string,
  limit: number,
): Effect.Effect<QueryResults, MemoryDatabaseError> {
  const database = requireDatabase(commandCtx);
  const vectorize = database.vectorize;
  if (!vectorize) {
    usageError("Semantic search requires the remote backend: query --remote.");
  }
  if (limit > SEARCH_LIMIT_MAX) {
    usageError(
      `--limit must be an integer between 1 and ${SEARCH_LIMIT_MAX} for semantic and hybrid search.`,
    );
  }
  const topK = semanticCandidateCount(limit);

  const filters = parseCommonFilters(commandCtx.args);
  const queryTokens = extractTerms([term, filters.tag ?? ""].join(" "));
  const status =
    filters.status ?? (filters.includeDeprecated ? undefined : "active");

  const searchRequest = {
    repository: repositoryForCurrentDirectory(),
    query: term,
    top_k: topK,
  } satisfies JsonObject;
  if (status !== undefined) {
    Object.assign(searchRequest, { status });
  }
  if (filters.memoryType !== undefined) {
    Object.assign(searchRequest, { memory_type: filters.memoryType });
  }
  if (filters.certainty !== undefined) {
    Object.assign(searchRequest, { certainty: filters.certainty });
  }

  return vectorize.search(searchRequest).pipe(
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
        const results: JsonObject[] = [];
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
            !stringValue(row.tags)
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
  return fetchSemanticCandidates(commandCtx, term, limit).pipe(
    Effect.map((result) => ({
      ...result,
      results: orderRowsByMatchStrength(
        annotateMatches(result.results, termMatchQuery(term)),
      ).slice(0, limit),
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
        limit: FTS_CANDIDATE_LIMIT,
      }),
      fetchSemanticCandidates(commandCtx, term, limit),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([fts, semantic]) => ({
      results: combineHybridResults(
        fts.results,
        semantic.results,
        limit,
        options.explainScore,
        termMatchQuery(term),
      ),
      queryTokens: fts.queryTokens,
      filters: fts.filters,
    })),
  );
}

export function handleQueryCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args } = commandCtx;
    const term = commandCtx.positionals[0];
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
    const fetched = yield* fetchResults(commandCtx, term, {
      explainScore,
      limit: parseResultLimit(args),
    });
    const { queryTokens, filters } = fetched;
    const results = orderRowsByMatchStrength(
      annotateMatches(fetched.results, termMatchQuery(term)),
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
          ? HYBRID_FUSION
          : semantic
            ? undefined
            : SEARCH_SCORE_WEIGHTS,
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
        const payload = {
          count: normalized.length,
          ids: resultIds(normalized),
        } satisfies JsonObject;
        if (outputMode.jsonMin) {
          Object.assign(payload, {
            results: normalized.map(minimalResultSummary),
          });
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

export function buildSuggestSnapshot(args: string[]): SuggestSnapshot {
  const files = parseSuggestFiles(args);
  const normalizedPathTerms = extractPathTerms(files);
  const neighborhood = deriveFileNeighborhood(files);
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
    ftsQuery: buildFtsQuery(normalizedPathTerms),
  };
}

function fetchFtsSuggestResults(
  commandCtx: CommandContext,
  snapshot: SuggestSnapshot,
  options: FetchResultsOptions,
): Effect.Effect<JsonObject[], MemoryDatabaseError> {
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
       LIMIT ${FTS_CANDIDATE_LIMIT}`,
      ftsParams,
    )
    .pipe(
      Effect.map((rows) =>
        scoreRowsWithDetails(rows, snapshot.suggestTerms, {
          explainScore: options.explainScore,
          identifiers: fileIdentifiers(snapshot.files),
          scope: "files",
        }),
      ),
    );
}

export function collectSuggestResults(
  commandCtx: CommandContext,
  snapshot: SuggestSnapshot,
  options: FetchResultsOptions,
): Effect.Effect<JsonObject[], MemoryDatabaseError> {
  return Effect.gen(function* () {
    const limit = options.limit ?? 8;
    const neighborhoodResults = yield* queryNeighborhoodMatches(
      requireDatabase(commandCtx),
      snapshot.neighborhood,
      snapshot.filters,
    );
    const ftsResults = yield* fetchFtsSuggestResults(
      commandCtx,
      snapshot,
      options,
    );
    return orderRowsByMatchStrength(
      annotateMatches(
        mergeSuggestionResults(ftsResults, neighborhoodResults),
        suggestMatchQuery(snapshot),
      ),
    ).slice(0, limit);
  });
}

function printSuggestResults(
  commandCtx: CommandContext,
  snapshot: SuggestSnapshot,
  results: JsonObject[],
  options: FetchResultsOptions,
) {
  const { outputMode } = commandCtx;
  if (outputMode.jsonMin || outputMode.quiet) {
    printJson(
      minimalScoredPayload(results, {
        jsonMin: outputMode.jsonMin,
        scoreWeights: options.explainScore ? SEARCH_SCORE_WEIGHTS : undefined,
      }),
    );
    return;
  }
  if (outputMode.brief) {
    printBriefLines(results);
    return;
  }

  const output = {
    files: snapshot.files,
    normalized_files: snapshot.files,
    normalized_path_terms: snapshot.normalizedPathTerms,
    derived_terms: snapshot.suggestTerms,
    neighborhood: {
      tags: snapshot.neighborhood.tagHints,
      paths: snapshot.neighborhood.pathHints,
    },
    no_strong_match: !hasStrongMatchRow(results),
    results,
  } satisfies JsonObject;
  if (options.explainScore) {
    Object.assign(output, { score_weights: SEARCH_SCORE_WEIGHTS });
  }
  printCommandOutput(commandCtx, output);
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
    results: JsonObject[];
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
        results: scoreRowsWithDetails(rows, scoreTerms, {
          explainScore: options.explainScore,
        }).slice(0, options.limit ?? 8),
        filters,
      })),
    );
}

/** A sweep query makes lexical matches meaningful; file terms alone do not. */
function sweepMatchQuery(
  snapshot: SuggestSnapshot,
  queryTerm: string | undefined,
): SearchMatchQuery {
  const files = fileIdentifiers(snapshot.files);
  if (queryTerm === undefined) {
    return suggestMatchQuery(snapshot);
  }
  return {
    terms: extractTerms(queryTerm),
    identifiers: uniqueLowerPreserveOrder([
      ...files,
      ...extractQueryIdentifiers(queryTerm),
    ]),
  };
}

function mergeSweepRows(
  left: JsonObject,
  right: JsonObject,
  source: SweepSource,
): JsonObject {
  const currentSources: SweepSource[] = [];
  if (Array.isArray(left.sources)) {
    for (const item of left.sources) {
      if (item === "suggest" || item === "query" || item === "list") {
        currentSources.push(item);
      }
    }
  }
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
  parts: { source: SweepSource; rows: JsonObject[] }[],
): JsonObject[] {
  const byId = new Map<number, JsonObject>();
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
          // SAFETY: empty array literal; string[] cannot be violated.
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
    const results = orderRowsByMatchStrength(
      annotateMatches(
        mergeSweepResults([
          { source: "suggest", rows: suggestResults },
          { source: "query", rows: queryBundle.results },
          { source: "list", rows: listBundle.results },
        ]),
        sweepMatchQuery(snapshot, queryTerm),
      ),
    ).slice(0, limit);
    yield* Effect.sync(() => {
      if (outputMode.jsonMin || outputMode.quiet) {
        printJson(
          minimalScoredPayload(results, {
            jsonMin: outputMode.jsonMin,
            scoreWeights: explainScore ? SEARCH_SCORE_WEIGHTS : undefined,
            summarize: (row) => ({
              ...minimalScoredResultSummary(row),
              sources: row.sources ?? [],
            }),
          }),
        );
        return;
      }
      if (outputMode.brief) {
        printBriefLines(results);
        return;
      }
      const output = {
        files: snapshot.files,
        normalized_files: snapshot.files,
        normalized_path_terms: snapshot.normalizedPathTerms,
        derived_terms: snapshot.suggestTerms,
        query: queryTerm ?? null,
        filters: { tags: listBundle.filters.tag ?? null },
        no_strong_match: !hasStrongMatchRow(results),
        results,
      } satisfies JsonObject;
      if (explainScore) {
        Object.assign(output, { score_weights: SEARCH_SCORE_WEIGHTS });
      }
      printCommandOutput(commandCtx, output);
    });
  });
}

import {
  FTS_CANDIDATE_LIMIT,
  isExpiredStatus,
  isGenericFile,
  SEARCH_LIMIT_MAX,
  SEARCH_SCORE_WEIGHTS,
  buildFtsQuery,
  deriveFileNeighborhood,
  extractPathTerms,
  extractQueryIdentifiers,
  extractTerms,
  fileIdentifiers,
  semanticCandidateCount,
  sqliteDateToMs,
  type FileNeighborhood,
} from "@machine-memory/contract";
import { Effect } from "effect";

import { appendWriterFilter, requestedWriter } from "../../attribution";
import {
  type CommandFlags,
  getFlagValue,
  hasFlag,
  usageError,
} from "../../cli-utils";
import type { MemoryDatabaseError } from "../../effect/database";
import { jsonNumber, jsonObject, type JsonObject } from "../../json";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { hasMinimalOutput, printRead, readEnvelope } from "../runtime/output";
import {
  HYBRID_FUSION,
  annotateMatches,
  applySqlFilters,
  repositoryClause,
  combineHybridResults,
  hasStrongMatchRow,
  mergeSuggestionResults,
  minimalResultSummary,
  orderRowsByMatchStrength,
  normalizeSqliteRow,
  parseCommonFilters,
  parseIntegerFlag,
  parseResultLimit,
  parseSuggestFiles,
  queryEmptyResultPayload,
  queryNeighborhoodMatches,
  readScope,
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
  /** Manifests and lockfiles among the files; their names are not searched. */
  genericFiles: string[];
  normalizedPathTerms: string[];
  suggestTerms: string[];
  neighborhood: FileNeighborhood;
  filters: ReturnType<typeof parseCommonFilters>;
  ftsQuery: string | undefined;
};

type SweepSource = "suggest" | "query" | "list";

function explainScoreEnabled(flags: CommandFlags): boolean {
  return hasFlag(flags, "--explain-score");
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

/** The envelope of a scored read: adds whether anything matched strongly. */
function scoredEnvelope(
  commandCtx: Pick<CommandContext, "outputMode">,
  results: JsonObject[],
  options: {
    scope: JsonObject;
    /** Fields only the full output carries, such as the derived search terms. */
    detail?: JsonObject;
    /** Fields every output mode carries, because they explain the results. */
    always?: JsonObject;
    scoreWeights?: JsonObject | undefined;
    summarize?: (row: JsonObject) => JsonObject;
  },
): JsonObject {
  const extras: JsonObject = { ...options.always };
  if (!hasMinimalOutput(commandCtx.outputMode)) {
    Object.assign(extras, options.detail);
  }
  extras.no_strong_match = !hasStrongMatchRow(results);
  if (options.scoreWeights !== undefined) {
    extras.score_weights = options.scoreWeights;
  }
  return readEnvelope(commandCtx.outputMode, options.scope, results, {
    extras,
    summarize: options.summarize ?? minimalScoredResultSummary,
  });
}

function termMatchQuery(term: string): SearchMatchQuery {
  return {
    terms: extractTerms(term),
    identifiers: extractQueryIdentifiers(term),
  };
}

function genericFilesNote(snapshot: SuggestSnapshot): JsonObject {
  return snapshot.genericFiles.length === 0
    ? {}
    : { generic_files: snapshot.genericFiles };
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
  const { flags } = commandCtx;
  const database = requireDatabase(commandCtx);
  const filters = parseCommonFilters(flags);
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
    hideExpiredStatus: true,
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

function rowIsExpiredStatus(row: JsonObject): boolean {
  return isExpiredStatus(
    {
      memory_type: stringValue(row.memory_type),
      expires_after_days: jsonNumber(row.expires_after_days) ?? null,
    },
    sqliteDateToMs(stringValue(row.updated_at)),
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

  const filters = parseCommonFilters(commandCtx.flags);
  const queryTokens = extractTerms([term, filters.tag ?? ""].join(" "));
  const status =
    filters.status ?? (filters.includeDeprecated ? undefined : "active");

  const searchRequest = {
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

  // Each repository is its own Vectorize namespace: search each, keep the best.
  const repositories = repositoryClause();
  return Effect.forEach(repositories.params, (repository) =>
    vectorize.search({ ...searchRequest, repository }),
  ).pipe(
    Effect.map((searches) => ({
      matches: searches
        .flatMap((search) => search.matches)
        .sort((left, right) => right.score - left.score)
        .slice(0, topK),
    })),
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
             WHERE ${repositories.sql} AND id IN (${validIds.map(() => "?").join(", ")})`,
          [...repositories.params, ...validIds],
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
          if (filters.memoryType !== "status" && rowIsExpiredStatus(row)) {
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
    const { flags } = commandCtx;
    const term = commandCtx.positionals[0];
    if (!term) {
      usageError("Usage: query <search_term>");
    }
    const explainScore = explainScoreEnabled(flags);
    const semantic = hasFlag(flags, "--semantic");
    const hybrid = hasFlag(flags, "--hybrid");
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
      limit: parseResultLimit(flags),
    });
    const { queryTokens, filters } = fetched;
    const results = orderRowsByMatchStrength(
      annotateMatches(fetched.results, termMatchQuery(term)),
    );
    const scope = yield* readScope(requireDatabase(commandCtx), results.length);
    const scoreWeights = hybrid
      ? HYBRID_FUSION
      : semantic
        ? undefined
        : SEARCH_SCORE_WEIGHTS;
    yield* Effect.sync(() => {
      printRead(
        commandCtx,
        results,
        scoredEnvelope(commandCtx, results, {
          scope,
          // An empty result says what was searched and how to widen it.
          detail:
            results.length === 0
              ? queryEmptyResultPayload(term, filters, queryTokens)
              : undefined,
          scoreWeights: explainScore ? scoreWeights : undefined,
        }),
      );
    });
  });
}

const LIST_LIMIT_DEFAULT = 100;

/** --offset for paging through list; 0 when absent. */
function parseListOffset(flags: CommandFlags): number {
  const parsed = parseIntegerFlag(flags, "--offset");
  if (parsed === undefined) {
    return 0;
  }
  if (parsed === null || parsed < 0) {
    usageError("--offset must be a non-negative integer.");
  }
  return parsed;
}

export function handleListCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { flags } = commandCtx;
    const database = requireDatabase(commandCtx);
    const filters = parseCommonFilters(flags);
    const limit = parseResultLimit(flags, LIST_LIMIT_DEFAULT);
    const offset = parseListOffset(flags);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    applySqlFilters(clauses, params, filters, { defaultActiveOnly: true });
    appendWriterFilter(clauses, params, requestedWriter(flags));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = yield* database.all(
      `SELECT * FROM memories ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const counted = yield* database.get(
      `SELECT COUNT(*) AS total FROM memories ${where}`,
      params,
    );
    const totalCount = jsonNumber(jsonObject(counted)?.total) ?? 0;
    const normalized = rows.map((row) => normalizeSqliteRow(row));
    // An empty page past the end is not an empty repository.
    const scope = yield* readScope(database, totalCount);
    yield* Effect.sync(() => {
      printRead(
        commandCtx,
        normalized,
        readEnvelope(commandCtx.outputMode, scope, normalized, {
          extras: {
            total_count: totalCount,
            offset,
            limit,
            has_more: offset + normalized.length < totalCount,
          },
        }),
      );
    });
  });
}

export function buildSuggestSnapshot(flags: CommandFlags): SuggestSnapshot {
  const files = parseSuggestFiles(flags);
  const normalizedPathTerms = extractPathTerms(files);
  const neighborhood = deriveFileNeighborhood(files);
  const suggestTerms = uniqueLowerPreserveOrder([
    ...normalizedPathTerms,
    ...neighborhood.terms,
  ]);
  return {
    files,
    genericFiles: files.filter(isGenericFile),
    normalizedPathTerms,
    suggestTerms,
    neighborhood,
    filters: parseCommonFilters(flags),
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
    hideExpiredStatus: true,
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
  options: { explainScore: boolean; scope: JsonObject },
) {
  printRead(
    commandCtx,
    results,
    scoredEnvelope(commandCtx, results, {
      scope: options.scope,
      always: genericFilesNote(snapshot),
      detail: {
        files: snapshot.files,
        normalized_files: snapshot.files,
        normalized_path_terms: snapshot.normalizedPathTerms,
        derived_terms: snapshot.suggestTerms,
        neighborhood: {
          tags: snapshot.neighborhood.tagHints,
          paths: snapshot.neighborhood.pathHints,
        },
      },
      scoreWeights: options.explainScore ? SEARCH_SCORE_WEIGHTS : undefined,
    }),
  );
}

export function handleSuggestCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const explainScore = explainScoreEnabled(commandCtx.flags);
    const snapshot = buildSuggestSnapshot(commandCtx.flags);
    const results = yield* collectSuggestResults(commandCtx, snapshot, {
      explainScore,
      limit: parseResultLimit(commandCtx.flags),
    });
    const scope = yield* readScope(requireDatabase(commandCtx), results.length);
    yield* Effect.sync(() =>
      printSuggestResults(commandCtx, snapshot, results, {
        explainScore,
        scope,
      }),
    );
  });
}

function ensureSweepFileArgs(flags: CommandFlags) {
  const filesRaw = getFlagValue(flags, "--files");
  const filesJsonRaw = getFlagValue(flags, "--files-json");
  if (!filesRaw && !filesJsonRaw) {
    usageError(`Usage: ${SWEEP_USAGE}`);
  }
  if (filesRaw && filesJsonRaw) {
    usageError("Use either --files or --files-json, not both.");
  }
}

function parseSweepQueryArg(flags: CommandFlags): string | undefined {
  const value = getFlagValue(flags, "--query");
  if (hasFlag(flags, "--query") && value === undefined) {
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
  const filters = parseCommonFilters(commandCtx.flags);
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  applySqlFilters(clauses, params, filters, {
    defaultActiveOnly: true,
    columnPrefix: "m.",
    hideExpiredStatus: true,
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
    const { flags } = commandCtx;
    ensureSweepFileArgs(flags);
    const queryTerm = parseSweepQueryArg(flags);
    const explainScore = explainScoreEnabled(flags);
    const limit = parseResultLimit(flags);
    const snapshot = buildSuggestSnapshot(flags);
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
          filters: parseCommonFilters(flags),
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
    const scope = yield* readScope(requireDatabase(commandCtx), results.length);
    yield* Effect.sync(() => {
      printRead(
        commandCtx,
        results,
        scoredEnvelope(commandCtx, results, {
          scope,
          always: genericFilesNote(snapshot),
          detail: {
            files: snapshot.files,
            normalized_files: snapshot.files,
            normalized_path_terms: snapshot.normalizedPathTerms,
            derived_terms: snapshot.suggestTerms,
            query: queryTerm ?? null,
            filters: { tags: listBundle.filters.tag ?? null },
          },
          scoreWeights: explainScore ? SEARCH_SCORE_WEIGHTS : undefined,
          summarize: (row) => ({
            ...minimalScoredResultSummary(row),
            sources: row.sources ?? [],
          }),
        }),
      );
    });
  });
}

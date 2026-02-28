import { getFlagValue, hasFlag, printJson, usageError } from "../../cli";
import { allWithRetry } from "../../db";
import {
  SCORE_COMPONENT_WEIGHTS,
  applySqlFilters,
  buildFtsQueryFromTerms,
  compareFact,
  deriveNeighborhoodFromFiles,
  extractPathTermsFromFiles,
  extractTerms,
  getMemoryById,
  mergeSuggestionResults,
  normalizeSqliteRow,
  parseCommonFilters,
  parseSuggestFiles,
  printBriefLines,
  queryEmptyResultPayload,
  queryNeighborhoodMatches,
  shapeRowsWithScore,
  sortByScoreThenRecency,
  stringValue,
  uniqueLowerPreserveOrder,
} from "../shared";
import type { CommandContext } from "./context";

const SWEEP_USAGE =
  'sweep (--files "src/a.ts,src/b.ts" | --files-json \'["src/a.ts","src/b.ts"]\') [--query <search_term>] [--tags <tag>] [--brief|--json-min|--quiet]';

type FetchResultsOptions = {
  explainScore: boolean;
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

function printScoredResults(
  outputMode: CommandContext["outputMode"],
  results: Record<string, unknown>[],
  options: {
    explainScore: boolean;
    wrapResults?: boolean;
  },
) {
  if (outputMode.jsonMin || outputMode.quiet) {
    const payload: Record<string, unknown> = {
      count: results.length,
      ids: resultIds(results),
    };
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
  if (options.wrapResults) {
    printJson({
      results,
      ...(options.explainScore
        ? { score_weights: SCORE_COMPONENT_WEIGHTS }
        : {}),
    });
    return;
  }
  printJson(results);
}

function printEmptyQueryResults(
  term: string,
  filters: ReturnType<typeof parseCommonFilters>,
  queryTokens: string[],
  outputMode: CommandContext["outputMode"],
) {
  if (outputMode.brief) {
    printBriefLines([]);
    return;
  }
  printJson(queryEmptyResultPayload(term, filters, queryTokens));
}

function fetchQueryResults(
  commandCtx: CommandContext,
  term: string,
  options: FetchResultsOptions,
): QueryResults {
  const { args, requireDb } = commandCtx;
  const database = requireDb();
  const filters = parseCommonFilters(args);
  const queryTokens = extractTerms([term, filters.tag ?? ""].join(" "));
  const ftsQuery = buildFtsQueryFromTerms(queryTokens);
  if (!ftsQuery) {
    return { results: [], queryTokens, filters };
  }

  const clauses = ["memories_fts MATCH ?"];
  const params: (string | number)[] = [ftsQuery];
  applySqlFilters(clauses, params, filters, {
    defaultActiveOnly: true,
    columnPrefix: "m.",
  });

  const rows = allWithRetry(
    database,
    `SELECT m.*, bm25(memories_fts) AS fts_rank
     FROM memories m
     JOIN memories_fts ON m.id = memories_fts.rowid
     WHERE ${clauses.join(" AND ")}
     ORDER BY bm25(memories_fts)`,
    params,
  );

  const results = shapeRowsWithScore(rows as unknown[], queryTokens, {
    explainScore: options.explainScore,
  });
  return { results, queryTokens, filters };
}

export function handleQueryCommand(commandCtx: CommandContext) {
  const { args, outputMode } = commandCtx;
  const term = args[0];
  if (!term) {
    usageError("Usage: query <search_term>");
  }

  const explainScore = explainScoreEnabled(args);
  const { results, queryTokens, filters } = fetchQueryResults(
    commandCtx,
    term,
    {
      explainScore,
    },
  );
  if (results.length === 0) {
    printEmptyQueryResults(term, filters, queryTokens, outputMode);
    return;
  }

  printScoredResults(outputMode, results, {
    explainScore,
    wrapResults: explainScore,
  });
}

export function handleGetCommand(commandCtx: CommandContext) {
  const { args, requireDb } = commandCtx;
  const database = requireDb();
  const id = args[0];
  if (!id) {
    usageError("Usage: get <id>");
  }
  const row = getMemoryById(database, Number(id));
  printJson(row ?? { error: "Not found" });
}

export function handleListCommand(commandCtx: CommandContext) {
  const { args, outputMode, requireDb } = commandCtx;
  const database = requireDb();
  const filters = parseCommonFilters(args);
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  applySqlFilters(clauses, params, filters, { defaultActiveOnly: true });

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = allWithRetry(
    database,
    `SELECT * FROM memories ${where} ORDER BY updated_at DESC, id DESC`,
    params,
  );
  const normalized = (rows as unknown[]).map((row) => normalizeSqliteRow(row));
  if (outputMode.brief) {
    printBriefLines(normalized);
    return;
  }
  printJson(normalized);
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
): Record<string, unknown>[] {
  if (snapshot.ftsQuery === undefined) {
    return [];
  }
  const ftsClauses = ["memories_fts MATCH ?"];
  const ftsParams: (string | number)[] = [snapshot.ftsQuery];
  applySqlFilters(ftsClauses, ftsParams, snapshot.filters, {
    defaultActiveOnly: true,
    columnPrefix: "m.",
  });
  const rows = allWithRetry(
    commandCtx.requireDb(),
    `SELECT m.*, bm25(memories_fts) AS fts_rank
     FROM memories m
     JOIN memories_fts ON m.id = memories_fts.rowid
     WHERE ${ftsClauses.join(" AND ")}
     ORDER BY bm25(memories_fts)
     LIMIT 20`,
    ftsParams,
  );
  return shapeRowsWithScore(rows as unknown[], snapshot.suggestTerms, {
    explainScore: options.explainScore,
  });
}

function collectSuggestResults(
  commandCtx: CommandContext,
  snapshot: SuggestSnapshot,
  options: FetchResultsOptions,
): Record<string, unknown>[] {
  const neighborhoodResults = queryNeighborhoodMatches(
    commandCtx.requireDb(),
    snapshot.neighborhood,
    snapshot.filters,
  );
  const ftsResults = fetchFtsSuggestResults(commandCtx, snapshot, options);
  return mergeSuggestionResults(ftsResults, neighborhoodResults);
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

  printJson({
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
  const explainScore = explainScoreEnabled(commandCtx.args);
  const snapshot = buildSuggestSnapshot(commandCtx.args);
  const results = collectSuggestResults(commandCtx, snapshot, { explainScore });
  printSuggestResults(commandCtx, snapshot, results, { explainScore });
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
): {
  results: Record<string, unknown>[];
  filters: ReturnType<typeof parseCommonFilters>;
} {
  const filters = parseCommonFilters(commandCtx.args);
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  applySqlFilters(clauses, params, filters, {
    defaultActiveOnly: true,
    columnPrefix: "m.",
  });
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = allWithRetry(
    commandCtx.requireDb(),
    `SELECT m.*, 0 AS fts_rank
     FROM memories m
     ${where}
     ORDER BY m.updated_at DESC, m.id DESC`,
    params,
  );
  return {
    results: shapeRowsWithScore(rows as unknown[], scoreTerms, {
      explainScore: options.explainScore,
    }),
    filters,
  };
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
  const { args, outputMode } = commandCtx;
  ensureSweepFileArgs(args);
  const queryTerm = parseSweepQueryArg(args);
  const explainScore = explainScoreEnabled(args);

  const snapshot = buildSuggestSnapshot(args);
  const suggestResults = collectSuggestResults(commandCtx, snapshot, {
    explainScore,
  });

  const queryBundle = queryTerm
    ? fetchQueryResults(commandCtx, queryTerm, { explainScore })
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
  const listBundle = fetchListScoredResults(commandCtx, listScoreTerms, {
    explainScore,
  });

  const results = mergeSweepResults([
    { source: "suggest", rows: suggestResults },
    { source: "query", rows: queryBundle.results },
    { source: "list", rows: listBundle.results },
  ]);

  if (outputMode.jsonMin || outputMode.quiet) {
    const payload: Record<string, unknown> = {
      count: results.length,
      ids: resultIds(results),
    };
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

  printJson({
    files: snapshot.files,
    normalized_files: snapshot.files,
    normalized_path_terms: snapshot.normalizedPathTerms,
    derived_terms: snapshot.suggestTerms,
    query: queryTerm ?? null,
    filters: {
      tags: listBundle.filters.tag ?? null,
    },
    ...(explainScore ? { score_weights: SCORE_COMPONENT_WEIGHTS } : {}),
    results,
  });
}

function parseFactArgs(args: string[], usage: string) {
  const idRaw = args[0];
  const fact = args.slice(1).join(" ").trim();
  if (!idRaw || !fact) {
    usageError(usage);
  }
  const id = Number(idRaw);
  if (!Number.isInteger(id)) {
    usageError(`Invalid id: ${idRaw}`);
  }
  return { id, fact };
}

export function handleVerifyCommand(commandCtx: CommandContext) {
  const { args, requireDb } = commandCtx;
  const database = requireDb();
  const { id, fact } = parseFactArgs(args, "Usage: verify <id> <fact>");
  const memory = getMemoryById(database, id);
  if (!memory) {
    printJson({ error: "Not found" });
    return;
  }
  const storedContent = stringValue(memory.content);
  const result = compareFact(storedContent, fact);
  if (result.conflict) {
    printJson({
      id,
      ok: false,
      result: "conflict",
      warning: "Conflict",
      similarity: result.similarity,
    });
    return;
  }
  printJson({
    id,
    ok: true,
    result: "consistent",
    similarity: result.similarity,
  });
}

export function handleDiffCommand(commandCtx: CommandContext) {
  const { args, requireDb } = commandCtx;
  const database = requireDb();
  const { id, fact } = parseFactArgs(args, "Usage: diff <id> <new_content>");
  const memory = getMemoryById(database, id);
  if (!memory) {
    printJson({ error: "Not found" });
    return;
  }
  const currentContent = stringValue(memory.content);
  const result = compareFact(currentContent, fact);
  printJson({
    id,
    conflict: result.conflict,
    similarity: result.similarity,
    added_terms: result.addedTerms,
    removed_terms: result.removedTerms,
  });
}

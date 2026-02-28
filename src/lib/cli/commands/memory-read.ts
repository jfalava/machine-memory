import { printJson, usageError } from "../../cli";
import { allWithRetry } from "../../db";
import {
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
  stringValue,
  uniqueLowerPreserveOrder,
} from "../shared";
import type { CommandContext } from "./context";

function printScoredResults(
  outputMode: CommandContext["outputMode"],
  results: Record<string, unknown>[],
) {
  if (outputMode.jsonMin || outputMode.quiet) {
    printJson({
      count: results.length,
      ids: results.map((entry) => entry.id),
    });
    return;
  }
  if (outputMode.brief) {
    printBriefLines(results);
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
): {
  results: Record<string, unknown>[];
  queryTokens: string[];
  filters: ReturnType<typeof parseCommonFilters>;
} {
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
  applySqlFilters(clauses, params, filters, { defaultActiveOnly: true });

  const rows = allWithRetry(
    database,
    `SELECT m.*, bm25(memories_fts) AS fts_rank
     FROM memories m
     JOIN memories_fts ON m.id = memories_fts.rowid
     WHERE ${clauses.join(" AND ")}
     ORDER BY bm25(memories_fts)`,
    params,
  );

  const results = shapeRowsWithScore(rows as unknown[], queryTokens);
  return { results, queryTokens, filters };
}

export function handleQueryCommand(commandCtx: CommandContext) {
  const { args, outputMode } = commandCtx;
  const term = args[0];
  if (!term) {
    usageError("Usage: query <search_term>");
  }

  const { results, queryTokens, filters } = fetchQueryResults(commandCtx, term);
  if (results.length === 0) {
    printEmptyQueryResults(term, filters, queryTokens, outputMode);
    return;
  }

  printScoredResults(outputMode, results);
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

type SuggestSnapshot = {
  files: string[];
  suggestTerms: string[];
  neighborhood: ReturnType<typeof deriveNeighborhoodFromFiles>;
  filters: ReturnType<typeof parseCommonFilters>;
  ftsQuery: string | undefined;
};

function buildSuggestSnapshot(args: string[]): SuggestSnapshot {
  const files = parseSuggestFiles(args);
  const derivedTerms = extractPathTermsFromFiles(files);
  const neighborhood = deriveNeighborhoodFromFiles(files);
  const suggestTerms = uniqueLowerPreserveOrder([
    ...derivedTerms,
    ...neighborhood.terms,
  ]);
  return {
    files,
    suggestTerms,
    neighborhood,
    filters: parseCommonFilters(args),
    ftsQuery: buildFtsQueryFromTerms(derivedTerms),
  };
}

function fetchFtsSuggestResults(
  commandCtx: CommandContext,
  snapshot: SuggestSnapshot,
): Record<string, unknown>[] {
  if (snapshot.ftsQuery === undefined) {
    return [];
  }
  const ftsClauses = ["memories_fts MATCH ?"];
  const ftsParams: (string | number)[] = [snapshot.ftsQuery];
  applySqlFilters(ftsClauses, ftsParams, snapshot.filters, {
    defaultActiveOnly: true,
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
  return shapeRowsWithScore(rows as unknown[], snapshot.suggestTerms);
}

function printSuggestResults(
  commandCtx: CommandContext,
  snapshot: SuggestSnapshot,
  results: Record<string, unknown>[],
) {
  const { outputMode } = commandCtx;
  if (outputMode.jsonMin || outputMode.quiet) {
    printJson({
      count: results.length,
      ids: results.map((entry) => entry.id),
    });
    return;
  }
  if (outputMode.brief) {
    printBriefLines(results);
    return;
  }

  printJson({
    files: snapshot.files,
    derived_terms: snapshot.suggestTerms,
    neighborhood: {
      tags: snapshot.neighborhood.tagHints,
      paths: snapshot.neighborhood.pathHints,
    },
    results,
  });
}

export function handleSuggestCommand(commandCtx: CommandContext) {
  const snapshot = buildSuggestSnapshot(commandCtx.args);
  const neighborhoodResults = queryNeighborhoodMatches(
    commandCtx.requireDb(),
    snapshot.neighborhood,
    snapshot.filters,
  );
  const ftsResults = fetchFtsSuggestResults(commandCtx, snapshot);
  const results = mergeSuggestionResults(ftsResults, neighborhoodResults);
  printSuggestResults(commandCtx, snapshot, results);
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

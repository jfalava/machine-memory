/* eslint-disable max-statements, complexity */
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

export function handleQueryCommand(commandCtx: CommandContext) {
  const { args, outputMode, requireDb } = commandCtx;
  const database = requireDb();
  const term = args[0];
  if (!term) {
    usageError("Usage: query <search_term>");
  }

  const filters = parseCommonFilters(args);
  const queryTokens = extractTerms([term, filters.tag ?? ""].join(" "));
  const ftsQuery = buildFtsQueryFromTerms(queryTokens);
  if (!ftsQuery) {
    printEmptyQueryResults(term, filters, queryTokens, outputMode);
    return;
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

export function handleSuggestCommand(commandCtx: CommandContext) {
  const { args, outputMode, requireDb } = commandCtx;
  const database = requireDb();
  const files = parseSuggestFiles(args);
  const derivedTerms = extractPathTermsFromFiles(files);
  const neighborhood = deriveNeighborhoodFromFiles(files);
  const suggestTerms = [...new Set([...derivedTerms, ...neighborhood.terms])];
  const ftsQuery = buildFtsQueryFromTerms(derivedTerms);

  const filters = parseCommonFilters(args);
  const neighborhoodResults = queryNeighborhoodMatches(
    database,
    neighborhood,
    filters,
  );
  const ftsClauses = ftsQuery ? ["memories_fts MATCH ?"] : [];
  const ftsParams: (string | number)[] = ftsQuery ? [ftsQuery] : [];
  applySqlFilters(ftsClauses, ftsParams, filters, {
    defaultActiveOnly: true,
  });

  const rows =
    ftsQuery === undefined
      ? []
      : allWithRetry(
          database,
          `SELECT m.*, bm25(memories_fts) AS fts_rank
           FROM memories m
           JOIN memories_fts ON m.id = memories_fts.rowid
           WHERE ${ftsClauses.join(" AND ")}
           ORDER BY bm25(memories_fts)
           LIMIT 20`,
          ftsParams,
        );

  const ftsResults = shapeRowsWithScore(rows as unknown[], suggestTerms);
  const results = mergeSuggestionResults(ftsResults, neighborhoodResults);

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
    files,
    derived_terms: suggestTerms,
    neighborhood: {
      tags: neighborhood.tagHints,
      paths: neighborhood.pathHints,
    },
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

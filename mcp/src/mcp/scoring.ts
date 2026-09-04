import { buildFtsQuery, extractTerms } from "./fts";
import type { FtsRankedMemoryRow, MemoryRow, ScoredMemoryRow } from "./types";

function sqliteDateToMs(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function certaintyPoints(certainty: string): number {
  if (certainty === "verified") {
    return 20;
  }
  if (certainty === "inferred") {
    return 10;
  }
  return 2;
}

function recencyPoints(updatedAt: string): number {
  const ms = sqliteDateToMs(updatedAt);
  if (ms === null) {
    return 0;
  }
  const ageDays = Math.max(0, (Date.now() - ms) / (1000 * 60 * 60 * 24));
  const capped = Math.min(ageDays, 180);
  return Number((30 * (1 - capped / 180)).toFixed(3));
}

function tagMatchPoints(tags: string, queryTokens: string[]): number {
  if (tags === "" || queryTokens.length === 0) {
    return 0;
  }
  const tagList = tags
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  const tokenSet = new Set(queryTokens.map((token) => token.toLowerCase()));
  if (tagList.some((tag) => tokenSet.has(tag))) {
    return 18;
  }
  if (
    tagList.some((tag) =>
      queryTokens.some((token) => tag.includes(token.toLowerCase())),
    )
  ) {
    return 8;
  }
  return 0;
}

function updateCountPoints(updateCount: number): number {
  if (!Number.isFinite(updateCount) || updateCount <= 0) {
    return 0;
  }
  return Math.min(updateCount, 10) * 2;
}

function ftsRankPoints(ftsRank: number): number {
  if (!Number.isFinite(ftsRank)) {
    return 0;
  }
  return Number(Math.max(0, Math.min(30, ftsRank * -10)).toFixed(3));
}

/**
 * Port of the CLI result scorer (recency + certainty + tag match +
 * update count + FTS rank).
 */
export function scoreMemoryRows(
  rows: readonly FtsRankedMemoryRow[],
  queryTokens: string[],
): ScoredMemoryRow[] {
  return rows
    .map((row) => ({
      id: row.id,
      repository: row.repository,
      content: row.content,
      tags: row.tags,
      context: row.context,
      memory_type: row.memory_type,
      status: row.status,
      certainty: row.certainty,
      updated_at: row.updated_at,
      update_count: row.update_count,
      score: Number(
        (
          recencyPoints(row.updated_at) +
          certaintyPoints(row.certainty) +
          tagMatchPoints(row.tags, queryTokens) +
          updateCountPoints(row.update_count) +
          ftsRankPoints(row.fts_rank)
        ).toFixed(3),
      ),
    }))
    .sort((left, right) => right.score - left.score);
}

/** Project a ranked row onto the public memory shape plus its score. */
export function scoredResultRow(
  row: ScoredMemoryRow,
): MemoryRow & { score: number } {
  return {
    id: row.id,
    repository: row.repository,
    content: row.content,
    tags: row.tags,
    context: row.context,
    memory_type: row.memory_type,
    status: row.status,
    certainty: row.certainty,
    score: row.score,
  };
}

/** Port of the CLI `--match` resolver: best active FTS hit, scored like suggest. */
export async function findBestMemoryMatch(
  db: D1Database,
  repository: string,
  query: string,
): Promise<{ row: MemoryRow; score: number } | null> {
  const terms = extractTerms(query);
  const ftsQuery = buildFtsQuery(terms);
  if (ftsQuery === undefined) {
    return null;
  }
  const result = await db
    .prepare(
      `SELECT m.*, bm25(memories_fts) AS fts_rank
       FROM memories m
       JOIN memories_fts ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.repository = ? AND m.status = 'active'
       ORDER BY bm25(memories_fts)
       LIMIT 5`,
    )
    .bind(ftsQuery, repository)
    .all<FtsRankedMemoryRow>();
  const best = scoreMemoryRows(result.results ?? [], terms)[0];
  if (!best) {
    return null;
  }
  return { row: scoredResultRow(best), score: best.score };
}

/** Port of the CLI add conflict detector: top scored active overlaps. */
export async function detectMemoryConflicts(
  db: D1Database,
  repository: string,
  payload: { content: string; tags: string; context: string },
  options: { excludeId?: number; limit?: number } = {},
): Promise<Array<MemoryRow & { score: number }>> {
  const terms = extractTerms(
    [payload.content, payload.tags, payload.context].join(" "),
  );
  const ftsQuery = buildFtsQuery(terms);
  if (ftsQuery === undefined) {
    return [];
  }
  const clauses = [
    "memories_fts MATCH ?",
    "m.repository = ?",
    "m.status = 'active'",
  ];
  const params: (string | number)[] = [ftsQuery, repository];
  if (options.excludeId !== undefined) {
    clauses.push("m.id != ?");
    params.push(options.excludeId);
  }
  const result = await db
    .prepare(
      `SELECT m.*, bm25(memories_fts) AS fts_rank
       FROM memories m
       JOIN memories_fts ON m.id = memories_fts.rowid
       WHERE ${clauses.join(" AND ")}
       ORDER BY bm25(memories_fts)
       LIMIT ${Number(options.limit ?? 5)}`,
    )
    .bind(...params)
    .all<FtsRankedMemoryRow>();
  return scoreMemoryRows(result.results ?? [], terms).map(scoredResultRow);
}

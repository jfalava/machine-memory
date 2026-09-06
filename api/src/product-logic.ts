import {
  composeEmbeddingText,
  StoredMemoryRowSchema,
  MemorySummarySchema,
  normalizeStoredMemoryRow,
  type MemoryRow,
  type MemorySummary,
  type FactCheckResult,
  type MemoryDoctorFinding,
  type MemoryDoctorResult,
  type ScoredMemoryRow,
  type MemoryStatsResult,
  UPSERT_DEFAULT_MIN_SCORE,
  UPSERT_MIN_SIMILARITY,
  isJsonArray,
  jsonNumber,
  jsonString,
  type JsonObject,
  type JsonValue,
} from "@machine-memory/contract";
import { Schema } from "effect";

export type RankedMemoryRow = MemorySummary & {
  readonly updated_at: string;
  readonly update_count: number;
};

export type FtsRankedMemoryRow = RankedMemoryRow & {
  readonly fts_rank: number;
};

/** Decode at the database boundary; invalid stored enums must not become typed rows. */
export function toProductRow(value: JsonObject): MemoryRow {
  return normalizeStoredMemoryRow(
    Schema.decodeUnknownSync(StoredMemoryRowSchema)(value),
  );
}

export function toRankedRow(value: JsonObject): FtsRankedMemoryRow {
  const row = toProductRow(value);
  return {
    ...Schema.decodeUnknownSync(MemorySummarySchema)(row),
    updated_at: row.updated_at ?? "",
    update_count: row.update_count,
    fts_rank: Number(value.fts_rank ?? 0),
  };
}

export function toScoredRow(
  row: RankedMemoryRow,
  score: number,
): ScoredMemoryRow {
  return {
    id: row.id,
    repository: row.repository,
    content: row.content,
    tags: row.tags,
    context: row.context,
    memory_type: row.memory_type,
    status: row.status,
    certainty: row.certainty,
    score,
  };
}

const STOPWORDS = new Set([
  "the",
  "and",
  "with",
  "from",
  "that",
  "this",
  "into",
  "your",
  "have",
  "for",
  "are",
  "use",
  "uses",
  "using",
]);

export function extractTerms(input: string): string[] {
  const tokens = (input.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 2 && !STOPWORDS.has(token),
  );
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      unique.push(token);
    }
  }
  return unique;
}

export function buildFtsQuery(terms: string[]): string | undefined {
  const usable = terms.filter((term) => term.length > 0).slice(0, 12);
  if (usable.length === 0) {
    return undefined;
  }
  return usable.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

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

const FACT_STOPWORDS = new Set([
  ...STOPWORDS,
  "src",
  "lib",
  "app",
  "test",
  "tests",
]);

function factTerms(input: string): Set<string> {
  const tokens = (input.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 2 && !FACT_STOPWORDS.has(token),
  );
  return new Set(tokens);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const term of left) {
    if (right.has(term)) {
      intersection += 1;
    }
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : Number((intersection / union).toFixed(3));
}

function hasNegation(text: string): boolean {
  return /\b(not|no|never|without|cannot|can't)\b/.test(text.toLowerCase());
}

export function compareMemoryFact(
  stored: string,
  candidate: string,
): FactCheckResult {
  const storedTerms = factTerms(stored);
  const candidateTerms = factTerms(candidate);
  const similarity = jaccardSimilarity(storedTerms, candidateTerms);
  return {
    similarity,
    conflict:
      hasNegation(stored) !== hasNegation(candidate) || similarity < 0.35,
    added_terms: [...candidateTerms]
      .filter((term) => !storedTerms.has(term))
      .slice(0, 12),
    removed_terms: [...storedTerms]
      .filter((term) => !candidateTerms.has(term))
      .slice(0, 12),
  };
}

function rawString(row: JsonObject, key: string, fallback = ""): string {
  return jsonString(row[key]) ?? fallback;
}

function rawNumber(row: JsonObject, key: string): number | null {
  const value = row[key];
  const numeric = jsonNumber(value);
  if (numeric !== undefined && Number.isInteger(numeric)) {
    return numeric;
  }
  const text = jsonString(value);
  if (text !== undefined && text.trim() !== "") {
    const parsed = Number(text);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function memoryTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function doctorFinding(
  kind: string,
  ids: number[],
  details: JsonObject = {},
): MemoryDoctorFinding {
  return { kind, ids, details };
}

type DoctorSnapshot = {
  readonly id: number;
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memoryType: string;
  readonly expiresAfterDays: number | null;
  readonly refs: JsonValue | undefined;
  readonly terms: Set<string>;
};

function doctorSnapshots(rows: readonly JsonObject[]): DoctorSnapshot[] {
  return rows.flatMap((row) => {
    const id = rawNumber(row, "id");
    if (id === null) {
      return [];
    }
    const content = rawString(row, "content");
    const tags = rawString(row, "tags");
    const context = rawString(row, "context");
    return [
      {
        id,
        content,
        tags,
        context,
        memoryType: rawString(row, "memory_type"),
        expiresAfterDays: rawNumber(row, "expires_after_days"),
        refs: row.refs,
        terms: new Set(extractTerms(`${content} ${tags} ${context}`)),
      },
    ];
  });
}

function exactDuplicateFindings(
  rows: readonly DoctorSnapshot[],
): MemoryDoctorFinding[] {
  const groups = new Map<string, DoctorSnapshot[]>();
  for (const row of rows) {
    const key = `${row.content}\u0001${row.tags}\u0001${row.context}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].flatMap((group) => {
    const keep = group[0];
    if (!keep || group.length < 2) {
      return [];
    }
    const duplicates = group.slice(1).map((row) => row.id);
    return [
      doctorFinding("exact_duplicate", [keep.id, ...duplicates], {
        keep_id: keep.id,
        duplicate_ids: duplicates,
      }),
    ];
  });
}

function bestNearDuplicate(
  row: DoctorSnapshot,
  rows: readonly DoctorSnapshot[],
  candidateIndexes: readonly number[],
): { id: number; similarity: number } | undefined {
  let best: { id: number; similarity: number } | undefined;
  for (const index of candidateIndexes) {
    const candidate = rows[index];
    if (!candidate) {
      continue;
    }
    const exact =
      row.content === candidate.content &&
      row.tags === candidate.tags &&
      row.context === candidate.context;
    const similarity = exact
      ? 0
      : jaccardSimilarity(row.terms, candidate.terms);
    if (
      similarity >= 0.78 &&
      (best === undefined || similarity > best.similarity)
    ) {
      best = { id: candidate.id, similarity };
    }
  }
  return best;
}

function nearCandidateIndexes(
  terms: Set<string>,
  postings: ReadonlyMap<string, readonly number[]>,
): number[] {
  const indexes = new Set<number>();
  for (const term of [...terms].slice(0, 12)) {
    for (const index of postings.get(term) ?? []) {
      indexes.add(index);
      if (indexes.size >= 120) {
        return [...indexes];
      }
    }
  }
  return [...indexes];
}

function addNearPostings(
  postings: Map<string, number[]>,
  terms: Set<string>,
  rowIndex: number,
): void {
  for (const term of terms) {
    const indexes = postings.get(term) ?? [];
    if (indexes.length < 200) {
      indexes.push(rowIndex);
      postings.set(term, indexes);
    }
  }
}

function nearDuplicateFindings(
  rows: readonly DoctorSnapshot[],
): MemoryDoctorFinding[] {
  const findings: MemoryDoctorFinding[] = [];
  const postings = new Map<string, number[]>();
  for (const [index, row] of rows.entries()) {
    if (row.terms.size === 0) {
      continue;
    }
    const candidates = nearCandidateIndexes(row.terms, postings);
    const best = bestNearDuplicate(row, rows, candidates);
    if (best) {
      findings.push(
        doctorFinding("near_duplicate", [best.id, row.id], {
          keep_id: best.id,
          duplicate_id: row.id,
          similarity: best.similarity,
        }),
      );
    }
    addNearPostings(postings, row.terms, index);
  }
  return findings;
}

function statusFindings(
  rows: readonly DoctorSnapshot[],
): MemoryDoctorFinding[] {
  const findings: MemoryDoctorFinding[] = [];
  const latestByTag = new Map<string, number>();
  for (const row of rows) {
    if (row.memoryType !== "status") {
      continue;
    }
    const tags = memoryTags(row.tags);
    const newerId = tags
      .map((tag) => latestByTag.get(tag))
      .find((id) => id !== undefined);
    if (newerId !== undefined) {
      findings.push(
        doctorFinding("stale_status_overlap", [row.id, newerId], {
          stale_id: row.id,
          superseded_by: newerId,
          shared_tags: tags.filter((tag) => latestByTag.get(tag) === newerId),
        }),
      );
    }
    for (const tag of tags) {
      if (!latestByTag.has(tag)) {
        latestByTag.set(tag, row.id);
      }
    }
    if (row.expiresAfterDays === null) {
      findings.push(
        doctorFinding("status_missing_expiry", [row.id], {
          suggested_days: 14,
        }),
      );
    }
  }
  return findings;
}

function canonicalThreadFindings(
  rows: readonly DoctorSnapshot[],
): MemoryDoctorFinding[] {
  const latestByThread = new Map<string, number>();
  const findings: MemoryDoctorFinding[] = [];
  for (const row of rows) {
    const tags = memoryTags(row.tags);
    const topic = tags.find((tag) => tag.startsWith("topic:"));
    if (!topic) {
      continue;
    }
    const area = tags.find((tag) => tag.startsWith("area:")) ?? "area:global";
    const kind =
      tags.find((tag) => tag.startsWith("kind:")) ?? `kind:${row.memoryType}`;
    const key = `${kind}|${area}|${topic}`;
    const canonicalId = latestByThread.get(key);
    if (canonicalId !== undefined) {
      findings.push(
        doctorFinding("canonical_thread_overlap", [row.id, canonicalId], {
          stale_id: row.id,
          canonical_id: canonicalId,
          thread_key: key,
        }),
      );
    } else {
      latestByThread.set(key, row.id);
    }
  }
  return findings;
}

const TRANSIENT_TERMS =
  /\b(current|currently|today|now|progress|blocked|wip|todo|failing|failed|broken|fixed|resolved|temporary)\b/i;
const DURABLE_TERMS =
  /\b(decision|decided|always|must|policy|architecture|standard|convention|rule|design|contract)\b/i;

function typeBoundaryFinding(
  row: DoctorSnapshot,
): MemoryDoctorFinding | undefined {
  const text = `${row.content} ${row.context}`;
  if (row.memoryType !== "status" && TRANSIENT_TERMS.test(text)) {
    return doctorFinding("transient_non_status", [row.id], {
      memory_type: row.memoryType,
      suggested_type: "status",
    });
  }
  if (
    row.memoryType === "status" &&
    DURABLE_TERMS.test(text) &&
    !TRANSIENT_TERMS.test(text)
  ) {
    return doctorFinding("status_looks_decision", [row.id], {
      suggested_type: "decision",
    });
  }
  return undefined;
}

function tagHygieneFindings(row: DoctorSnapshot): MemoryDoctorFinding[] {
  const normalizedTags = memoryTags(row.tags).join(",");
  const findings =
    normalizedTags === ""
      ? [doctorFinding("empty_tags", [row.id])]
      : normalizedTags === row.tags
        ? []
        : [
            doctorFinding("invalid_tags", [row.id], {
              tags: row.tags,
              normalized_tags: normalizedTags,
            }),
          ];
  const tags = memoryTags(row.tags);
  const taxonomyIssues = ["area", "topic", "kind"].filter(
    (scope) => !tags.some((tag) => tag.startsWith(`${scope}:`)),
  );
  const kind = tags.find((tag) => tag.startsWith("kind:"));
  if (kind && kind !== `kind:${row.memoryType}`) {
    taxonomyIssues.push("kind_mismatch");
  }
  if (normalizedTags !== "" && taxonomyIssues.length > 0) {
    findings.push(
      doctorFinding("taxonomy_mismatch", [row.id], {
        taxonomy_issues: taxonomyIssues,
      }),
    );
  }
  return findings;
}

function hasMalformedRefs(refs: DoctorSnapshot["refs"]): boolean {
  const text = jsonString(refs);
  if (text !== undefined) {
    try {
      return !Schema.is(Schema.Array(Schema.String))(JSON.parse(text));
    } catch {
      return true;
    }
  }
  return (
    !isJsonArray(refs) || refs.some((ref) => jsonString(ref) === undefined)
  );
}

function hygieneFindings(
  rows: readonly DoctorSnapshot[],
): MemoryDoctorFinding[] {
  return rows.flatMap((row) => {
    const findings = tagHygieneFindings(row);
    const typeBoundary = typeBoundaryFinding(row);
    if (typeBoundary) {
      findings.push(typeBoundary);
    }
    if (hasMalformedRefs(row.refs)) {
      findings.push(doctorFinding("malformed_refs", [row.id]));
    }
    return findings;
  });
}

export function analyzeMemoryDoctor(
  repository: string,
  rawRows: readonly JsonObject[],
): MemoryDoctorResult {
  const rows = doctorSnapshots(rawRows);
  const findings = [
    ...exactDuplicateFindings(rows),
    ...nearDuplicateFindings(rows),
    ...statusFindings(rows),
    ...canonicalThreadFindings(rows),
    ...hygieneFindings(rows),
  ];
  const countsByKind: Record<string, number> = {};
  for (const finding of findings) {
    countsByKind[finding.kind] = (countsByKind[finding.kind] ?? 0) + 1;
  }
  return {
    repository,
    checked: rows.length,
    count: findings.length,
    findings,
    counts_by_kind: countsByKind,
  };
}

type StatsOldest = { id: number; created_at: string | null; time: number };
type StatsAccumulator = {
  readonly byType: Record<string, number>;
  readonly byCertainty: Record<string, number>;
  readonly tagFrequency: Record<string, number>;
  active: number;
  deprecated: number;
  superseded: number;
  oldest: StatsOldest | null;
  stale: number;
  noTags: number;
};

function createStatsAccumulator(): StatsAccumulator {
  return {
    byType: {},
    byCertainty: {},
    tagFrequency: {},
    active: 0,
    deprecated: 0,
    superseded: 0,
    oldest: null,
    stale: 0,
    noTags: 0,
  };
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function ingestStatus(accumulator: StatsAccumulator, status: string): void {
  accumulator.active += status === "active" ? 1 : 0;
  accumulator.deprecated += status === "deprecated" ? 1 : 0;
  accumulator.superseded += status === "superseded_by" ? 1 : 0;
}

function ingestOldest(accumulator: StatsAccumulator, row: JsonObject): void {
  const createdAt = rawString(row, "created_at") || null;
  const time =
    createdAt === null
      ? Number.POSITIVE_INFINITY
      : (sqliteDateToMs(createdAt) ?? Number.POSITIVE_INFINITY);
  if (accumulator.oldest === null || time < accumulator.oldest.time) {
    accumulator.oldest = {
      id: rawNumber(row, "id") ?? 0,
      created_at: createdAt,
      time,
    };
  }
}

function ingestStatsRow(
  accumulator: StatsAccumulator,
  row: JsonObject,
  now: number,
): void {
  ingestStatus(accumulator, rawString(row, "status", "active"));
  incrementCount(
    accumulator.byType,
    rawString(row, "memory_type", "convention"),
  );
  incrementCount(
    accumulator.byCertainty,
    rawString(row, "certainty", "inferred"),
  );
  const tags = memoryTags(rawString(row, "tags"));
  accumulator.noTags += tags.length === 0 ? 1 : 0;
  for (const tag of tags) {
    incrementCount(accumulator.tagFrequency, tag);
  }
  ingestOldest(accumulator, row);
  const updatedTime = sqliteDateToMs(rawString(row, "updated_at"));
  accumulator.stale +=
    updatedTime !== null && (now - updatedTime) / 86_400_000 > 90 ? 1 : 0;
}

export function summarizeMemoryStats(
  repository: string,
  rows: readonly JsonObject[],
  now = Date.now(),
): MemoryStatsResult {
  const accumulator = createStatsAccumulator();
  for (const row of rows) {
    ingestStatsRow(accumulator, row, now);
  }
  const oldest = accumulator.oldest;
  return {
    repository,
    total_memories: rows.length,
    active: accumulator.active,
    deprecated: accumulator.deprecated,
    superseded: accumulator.superseded,
    breakdown_by_memory_type: accumulator.byType,
    breakdown_by_certainty: accumulator.byCertainty,
    tag_frequency_map: accumulator.tagFrequency,
    oldest_memory:
      oldest === null ? null : { id: oldest.id, created_at: oldest.created_at },
    memories_not_updated_over_90_days: accumulator.stale,
    memories_with_no_tags: accumulator.noTags,
  };
}

export function contentHead(text: string, maxChars = 120): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > maxChars
    ? `${flattened.slice(0, maxChars)}…`
    : flattened;
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

export function scoreMemoryRows(
  rows: readonly FtsRankedMemoryRow[],
  queryTokens: string[],
): Array<RankedMemoryRow & { score: number }> {
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

export function scoredResultRow(
  row: RankedMemoryRow & { score: number },
): ScoredMemoryRow {
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

function mergeSuggestRows(
  primary: Array<RankedMemoryRow & { score: number }>,
  secondary: Array<RankedMemoryRow & { score: number }>,
): Array<RankedMemoryRow & { score: number }> {
  const byId = new Map<number, RankedMemoryRow & { score: number }>();
  for (const row of primary) {
    byId.set(row.id, row);
  }
  for (const row of secondary) {
    const existing = byId.get(row.id);
    if (!existing) {
      byId.set(row.id, {
        ...row,
        score: Number((row.score + 12).toFixed(3)),
      });
      continue;
    }
    const nextScore = Math.max(existing.score, row.score + 12);
    byId.set(row.id, { ...existing, score: Number(nextScore.toFixed(3)) });
  }
  return [...byId.values()].sort((left, right) => right.score - left.score);
}

export function mergeScoredSuggestRows(
  primary: ScoredMemoryRow[],
  secondaryRanks: Array<RankedMemoryRow & { score: number }>,
): ScoredMemoryRow[] {
  const primaryRanks = primary.map((row) => ({
    ...row,
    updated_at: "",
    update_count: 0,
  }));
  return mergeSuggestRows(primaryRanks, secondaryRanks).map(scoredResultRow);
}

export function normalizeSuggestPath(value: string): string {
  const cleaned = value.trim().replaceAll("\\", "/");
  if (!cleaned) {
    return "";
  }
  return cleaned.replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
}

export function parseSuggestFilesParam(files: string): string[] {
  const seen = new Set<string>();
  const parsed: string[] = [];
  for (const item of files.split(",")) {
    const normalized = normalizeSuggestPath(item);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      parsed.push(normalized);
    }
  }
  return parsed;
}

export function extractPathTerms(paths: string[]): string[] {
  const terms: string[] = [];
  for (const path of paths) {
    for (const segment of normalizeSuggestPath(path)
      .split("/")
      .filter(Boolean)) {
      terms.push(segment);
      for (const piece of segment.split(/[._-]+/)) {
        if (piece) {
          terms.push(piece);
        }
      }
    }
  }
  return extractTerms(terms.join(" "));
}

export type FileNeighborhood = {
  readonly tagHints: string[];
  readonly pathHints: string[];
  readonly terms: string[];
};

const NEIGHBORHOOD_IGNORED_SEGMENTS = new Set([
  "src",
  "lib",
  "app",
  "apps",
  "test",
  "tests",
]);

function collectExtensionHint(
  directory: string,
  base: string,
  seenPaths: Set<string>,
  pathHints: string[],
): void {
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot + 1) : "";
  if (!extension) {
    return;
  }
  const hint = `${directory}/%.${extension}`;
  if (!seenPaths.has(hint.toLowerCase())) {
    seenPaths.add(hint.toLowerCase());
    pathHints.push(hint);
  }
}

function collectDirectoryTags(
  directory: string,
  seenTags: Set<string>,
  tagHints: string[],
): void {
  for (const segment of directory.split("/").filter(Boolean)) {
    const lower = segment.toLowerCase();
    if (!NEIGHBORHOOD_IGNORED_SEGMENTS.has(lower) && !seenTags.has(lower)) {
      seenTags.add(lower);
      tagHints.push(segment);
    }
  }
}

function collectFileHints(
  filePath: string,
  seenTags: Set<string>,
  seenPaths: Set<string>,
  tagHints: string[],
  pathHints: string[],
): void {
  const normalized = normalizeSuggestPath(filePath);
  const slash = normalized.lastIndexOf("/");
  const directory = slash < 0 ? "." : normalized.slice(0, slash);
  if (!directory || directory === ".") {
    return;
  }
  const lowerDir = directory.toLowerCase();
  if (!seenPaths.has(lowerDir)) {
    seenPaths.add(lowerDir);
    pathHints.push(`${directory}/`);
  }
  collectExtensionHint(
    directory,
    normalized.slice(slash + 1),
    seenPaths,
    pathHints,
  );
  collectDirectoryTags(directory, seenTags, tagHints);
}

export function deriveFileNeighborhood(files: string[]): FileNeighborhood {
  const tagHints: string[] = [];
  const pathHints: string[] = [];
  const seenTags = new Set<string>();
  const seenPaths = new Set<string>();
  for (const filePath of files) {
    collectFileHints(filePath, seenTags, seenPaths, tagHints, pathHints);
  }
  return {
    tagHints,
    pathHints,
    terms: extractTerms([...tagHints, ...pathHints].join(" ")),
  };
}

export function uniqueLowerPreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const lower = value.toLowerCase();
    if (value && !seen.has(lower)) {
      seen.add(lower);
      unique.push(value);
    }
  }
  return unique;
}

export function embeddingTextForMemory(input: {
  content: string;
  tags: string;
  context: string;
  memory_type: string;
  status: string;
  certainty: string;
}): string {
  return composeEmbeddingText({
    content: input.content,
    tags: input.tags,
    context: input.context,
    memory_type: input.memory_type,
    status: input.status,
    certainty: input.certainty,
  });
}

export type UpsertStrength = {
  readonly strong: boolean;
  readonly similarity: number;
  readonly score: number;
};

export function upsertStrength(
  stored: { content: string; tags: string; context: string },
  candidate: { content: string; tags: string; context: string },
  score: number,
  threshold: number = UPSERT_DEFAULT_MIN_SCORE,
): UpsertStrength {
  const similarity = compareMemoryFact(
    [stored.content, stored.tags, stored.context].join(" "),
    [candidate.content, candidate.tags, candidate.context].join(" "),
  ).similarity;
  return {
    strong: similarity >= UPSERT_MIN_SIMILARITY && score >= threshold,
    similarity,
    score,
  };
}

export { UPSERT_DEFAULT_MIN_SCORE, UPSERT_MIN_SIMILARITY };

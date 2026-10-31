import {
  assessMatch,
  certaintyPoints,
  extractTerms,
  jaccardSimilarity,
  normalizeSuggestPath,
  sqliteDateToMs,
  composeEmbeddingText,
  exactMatchPoints,
  ftsRankPoints,
  gotchaOverlaps,
  matchStrengthRank,
  matchText,
  recencyPoints,
  StoredMemoryRowSchema,
  MemorySummarySchema,
  normalizeStoredMemoryRow,
  tagMatchPoints,
  termCoveragePoints,
  updateCountPoints,
  type MatchAssessment,
  type MatchScope,
  type MemoryRow,
  type MemoryHistoryEntry,
  type MemorySummary,
  type MemoryDoctorFinding,
  type MemoryDoctorResult,
  type ScoredMemoryRow,
  type MemoryStatsResult,
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
  readonly refs: readonly string[];
};

export type FtsRankedMemoryRow = RankedMemoryRow & {
  readonly fts_rank: number;
};

/** Search terms plus literal identifiers used to assess absolute match strength. */
export type MatchQuery = {
  readonly terms: readonly string[];
  readonly identifiers: readonly string[];
  readonly scope?: MatchScope;
};

/** Decode at the database boundary; invalid stored enums must not become typed rows. */
export function toProductRow(value: JsonObject): MemoryRow {
  return normalizeStoredMemoryRow(
    Schema.decodeUnknownSync(StoredMemoryRowSchema)(value),
  );
}

export function toHistoryRow(value: JsonObject): MemoryHistoryEntry {
  const row = toProductRow({
    ...value,
    id: jsonNumber(value.memory_id) ?? 0,
    refs: jsonString(value.refs) ?? "[]",
  });
  return {
    ...row,
    revision_id: Number(value.revision_id),
    operation: jsonString(value.operation) ?? "update",
    snapshot_at: jsonString(value.snapshot_at) ?? "",
  };
}

export function toRankedRow(value: JsonObject): FtsRankedMemoryRow {
  const row = toProductRow(value);
  return {
    ...Schema.decodeUnknownSync(MemorySummarySchema)(row),
    updated_at: row.updated_at ?? "",
    update_count: row.update_count,
    refs: row.refs,
    fts_rank: Number(value.fts_rank ?? 0),
  };
}

export function assessRowMatch(
  row: Pick<MemorySummary, "content" | "tags" | "context"> & {
    readonly refs: readonly string[];
  },
  query: MatchQuery,
  semanticScore?: number,
): MatchAssessment {
  return assessMatch({
    queryTerms: query.terms,
    identifiers: query.identifiers,
    text: matchText([row.content, row.tags, row.context, ...row.refs]),
    semanticScore,
    scope: query.scope,
  });
}

/** Keeps the stronger assessment when one memory arrives from two retrievers. */
export function strongerMatch(
  left: MatchAssessment,
  right: MatchAssessment,
): MatchAssessment {
  return matchStrengthRank(right.match_strength) >
    matchStrengthRank(left.match_strength)
    ? right
    : left;
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
  readonly certainty: string;
  readonly evidence: string;
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
        certainty: rawString(row, "certainty"),
        evidence: rawString(row, "evidence", "[]"),
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
    if (row.certainty === "verified" && row.evidence.trim() === "[]") {
      // Legacy rows predate evidence; only a reviewer can say which kind applies.
      findings.push(
        doctorFinding("verified_without_evidence", [row.id], {
          hint: "Set the evidence kinds that were actually established, or lower certainty to inferred.",
        }),
      );
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
    ...gotchaOverlaps(
      rows.map((row) => ({
        id: row.id,
        content: row.content,
        memory_type: row.memoryType,
      })),
    ).map((overlap) =>
      doctorFinding("gotcha_overlap", [...overlap.ids], {
        shared_identifiers: overlap.shared_identifiers,
        hint: "Consolidate the shared workaround into one gotcha; keep version-specific limits in their own record and reference it.",
      }),
    ),
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

export type ScoredRankedRow = RankedMemoryRow &
  MatchAssessment & { readonly score: number };

export function scoreMemoryRows(
  rows: readonly FtsRankedMemoryRow[],
  query: MatchQuery,
): ScoredRankedRow[] {
  return rows
    .map((row) => {
      const match = assessRowMatch(row, query);
      const score =
        ftsRankPoints(row.fts_rank) +
        termCoveragePoints(match.term_coverage) +
        exactMatchPoints(match.exact_matches.length) +
        tagMatchPoints(memoryTags(row.tags), query.terms) +
        recencyPoints(sqliteDateToMs(row.updated_at)) +
        certaintyPoints(row.certainty) +
        updateCountPoints(row.update_count);
      return { ...row, ...match, score: Number(score.toFixed(3)) };
    })
    .sort(
      (left, right) =>
        matchStrengthRank(right.match_strength) -
          matchStrengthRank(left.match_strength) || right.score - left.score,
    );
}

export function scoredResultRow(
  row: MemorySummary & MatchAssessment & { readonly score: number },
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
    evidence: row.evidence,
    validation_gaps: row.validation_gaps,
    score: row.score,
    match_strength: row.match_strength,
    term_coverage: row.term_coverage,
    exact_matches: row.exact_matches,
  };
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

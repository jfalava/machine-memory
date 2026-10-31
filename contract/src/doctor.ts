import { Schema } from "effect";

import {
  jsonNumber,
  jsonString,
  type JsonObject,
  type JsonValue,
} from "./json";
import type {
  MemoryDoctorFinding,
  MemoryDoctorResult,
} from "./product/results";
import { factTerms, jaccardSimilarity } from "./ranking";
import { gotchaOverlaps } from "./reconcile";

/**
 * Hygiene checks over a repository's active memories, shared by the API's
 * product/doctor route and the CLI's doctor command. Rows arrive as stored
 * (text columns as strings), newest first.
 */

export const NEAR_DUPLICATE_THRESHOLD = 0.78;
const NEAR_DUPLICATE_MAX_CANDIDATES = 120;
const MAX_POSTINGS_PER_TERM = 200;
const NEAR_DUPLICATE_TERMS_PROBED = 12;
export const DEFAULT_STATUS_EXPIRY_DAYS = 14;

const TRANSIENT_INDICATORS = [
  "currently",
  "current",
  "today",
  "now",
  "phase",
  "progress",
  "blocked",
  "blocking",
  "wip",
  "in progress",
  "todo",
  "failing",
  "failed",
  "broken",
  "fixing",
  "fixed",
  "resolved",
  "pass",
  "passed",
  "snapshot",
  "temporary",
  "for now",
];
const DURABLE_INDICATORS = [
  "decision",
  "decided",
  "we chose",
  "always",
  "must",
  "policy",
  "architecture",
  "standard",
  "convention",
  "rule",
  "design",
  "contract",
];

type DoctorRow = {
  readonly id: number;
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memoryType: string;
  readonly certainty: string;
  readonly evidence: JsonValue | undefined;
  readonly expiresAfterDays: number | null;
  readonly refs: JsonValue | undefined;
  readonly terms: Set<string>;
};

/** Lowercased, trimmed, deduplicated comma-separated tags. */
export function normalizeTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** The stored form of a tag list; writes use it so the doctor's `invalid_tags` stays quiet. */
export function canonicalTags(value: string): string {
  return normalizeTags(value).join(",");
}

function finding(
  kind: string,
  ids: number[],
  details: JsonObject = {},
): MemoryDoctorFinding {
  return { kind, ids, details };
}

function integerOrNull(value: JsonValue | undefined): number | null {
  const numeric = jsonNumber(value) ?? Number(jsonString(value) ?? Number.NaN);
  return Number.isInteger(numeric) ? numeric : null;
}

function doctorRows(rows: readonly JsonObject[]): DoctorRow[] {
  return rows.flatMap((row) => {
    const id = integerOrNull(row.id);
    if (id === null) {
      return [];
    }
    const content = jsonString(row.content) ?? "";
    const tags = jsonString(row.tags) ?? "";
    const context = jsonString(row.context) ?? "";
    return [
      {
        id,
        content,
        tags,
        context,
        memoryType: jsonString(row.memory_type) ?? "",
        certainty: jsonString(row.certainty) ?? "",
        evidence: row.evidence,
        expiresAfterDays: integerOrNull(row.expires_after_days),
        refs: row.refs,
        terms: factTerms(`${content} ${tags} ${context}`),
      },
    ];
  });
}

function exactKey(row: DoctorRow): string {
  return `${row.content}\u0001${row.tags}\u0001${row.context}`;
}

function exactDuplicateFindings(
  rows: readonly DoctorRow[],
): MemoryDoctorFinding[] {
  const groups = new Map<string, DoctorRow[]>();
  for (const row of rows) {
    groups.set(exactKey(row), [...(groups.get(exactKey(row)) ?? []), row]);
  }
  return [...groups.values()].flatMap(([keep, ...duplicates]) => {
    if (!keep || duplicates.length === 0) {
      return [];
    }
    const duplicateIds = duplicates.map((row) => row.id);
    return [
      finding("exact_duplicate", [keep.id, ...duplicateIds], {
        keep_id: keep.id,
        duplicate_ids: duplicateIds,
      }),
    ];
  });
}

function nearCandidates(
  terms: Set<string>,
  postings: ReadonlyMap<string, readonly number[]>,
): number[] {
  const indexes = new Set<number>();
  for (const term of [...terms].slice(0, NEAR_DUPLICATE_TERMS_PROBED)) {
    for (const index of postings.get(term) ?? []) {
      indexes.add(index);
      if (indexes.size >= NEAR_DUPLICATE_MAX_CANDIDATES) {
        return [...indexes];
      }
    }
  }
  return [...indexes];
}

function bestNearDuplicate(
  row: DoctorRow,
  candidates: readonly (DoctorRow | undefined)[],
): { id: number; similarity: number } | undefined {
  let best: { id: number; similarity: number } | undefined;
  for (const candidate of candidates) {
    // Exact copies are reported as exact duplicates instead.
    if (!candidate || exactKey(candidate) === exactKey(row)) {
      continue;
    }
    const similarity = jaccardSimilarity(row.terms, candidate.terms);
    if (
      similarity >= NEAR_DUPLICATE_THRESHOLD &&
      (best === undefined || similarity > best.similarity)
    ) {
      best = { id: candidate.id, similarity };
    }
  }
  return best;
}

function addPostings(
  postings: Map<string, number[]>,
  terms: Set<string>,
  rowIndex: number,
): void {
  for (const term of terms) {
    const indexes = postings.get(term) ?? [];
    if (indexes.length < MAX_POSTINGS_PER_TERM) {
      indexes.push(rowIndex);
      postings.set(term, indexes);
    }
  }
}

function nearDuplicateFindings(
  rows: readonly DoctorRow[],
): MemoryDoctorFinding[] {
  const findings: MemoryDoctorFinding[] = [];
  const postings = new Map<string, number[]>();
  for (const [index, row] of rows.entries()) {
    if (row.terms.size === 0) {
      continue;
    }
    const candidates = nearCandidates(row.terms, postings).map((i) => rows[i]);
    const best = bestNearDuplicate(row, candidates);
    if (best) {
      findings.push(
        finding("near_duplicate", [best.id, row.id], {
          keep_id: best.id,
          duplicate_id: row.id,
          similarity: best.similarity,
        }),
      );
    }
    addPostings(postings, row.terms, index);
  }
  return findings;
}

function staleStatusFindings(
  rows: readonly DoctorRow[],
): MemoryDoctorFinding[] {
  const findings: MemoryDoctorFinding[] = [];
  const latestByTag = new Map<string, number>();
  for (const row of rows.filter((entry) => entry.memoryType === "status")) {
    const tags = normalizeTags(row.tags);
    const newerId = tags
      .map((tag) => latestByTag.get(tag))
      .find((id) => id !== undefined);
    if (newerId !== undefined) {
      findings.push(
        finding("stale_status_overlap", [row.id, newerId], {
          stale_id: row.id,
          superseded_by: newerId,
          shared_tags: tags.filter((tag) => latestByTag.get(tag) === newerId),
        }),
      );
    }
    for (const tag of tags.filter((entry) => !latestByTag.has(entry))) {
      latestByTag.set(tag, row.id);
    }
  }
  return findings;
}

function statusExpiryFindings(
  rows: readonly DoctorRow[],
): MemoryDoctorFinding[] {
  return rows
    .values()
    .filter(
      (row) => row.memoryType === "status" && row.expiresAfterDays === null,
    )
    .map((row) =>
      finding("status_missing_expiry", [row.id], {
        suggested_days: DEFAULT_STATUS_EXPIRY_DAYS,
      }),
    )
    .toArray();
}

type TagScopes = {
  area?: string;
  topic?: string;
  kind?: string;
  extraScoped: string[];
  unscoped: string[];
};

function tagScopes(tags: readonly string[]): TagScopes {
  const scopes: TagScopes = { extraScoped: [], unscoped: [] };
  for (const tag of tags) {
    const index = tag.indexOf(":");
    if (index <= 0 || index === tag.length - 1) {
      scopes.unscoped.push(tag);
      continue;
    }
    const namespace = tag.slice(0, index);
    if (
      (namespace === "area" || namespace === "topic" || namespace === "kind") &&
      scopes[namespace] === undefined
    ) {
      scopes[namespace] = tag.slice(index + 1);
    } else {
      scopes.extraScoped.push(tag);
    }
  }
  return scopes;
}

function tagSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function canonicalThreadFindings(
  rows: readonly DoctorRow[],
): MemoryDoctorFinding[] {
  const latestByThread = new Map<string, number>();
  const findings: MemoryDoctorFinding[] = [];
  for (const row of rows) {
    const scopes = tagScopes(normalizeTags(row.tags));
    if (scopes.topic === undefined) {
      continue;
    }
    const type = row.memoryType.toLowerCase();
    const key = [
      tagSegment(scopes.kind ?? type, type),
      tagSegment(scopes.area ?? "global", "global"),
      tagSegment(scopes.topic, "topic"),
    ].join("|");
    const canonicalId = latestByThread.get(key);
    if (canonicalId === undefined) {
      latestByThread.set(key, row.id);
      continue;
    }
    findings.push(
      finding("canonical_thread_overlap", [row.id, canonicalId], {
        stale_id: row.id,
        canonical_id: canonicalId,
        thread_key: key,
      }),
    );
  }
  return findings;
}

function indicatorMatches(
  text: string,
  indicators: readonly string[],
): string[] {
  return indicators.filter((indicator) =>
    indicator.includes(" ")
      ? text.includes(indicator)
      : new RegExp(`\\b${indicator}\\b`).test(text),
  );
}

function typeBoundaryFindings(row: DoctorRow): MemoryDoctorFinding[] {
  const text = `${row.content} ${row.context}`.toLowerCase();
  const transient = indicatorMatches(text, TRANSIENT_INDICATORS);
  const isStatus = row.memoryType.toLowerCase() === "status";
  if (!isStatus && transient.length > 0) {
    return [
      finding("transient_non_status", [row.id], {
        memory_type: row.memoryType,
        matched_terms: transient,
        suggested_type: "status",
      }),
    ];
  }
  const durable = indicatorMatches(text, DURABLE_INDICATORS);
  if (isStatus && durable.length > 0 && transient.length === 0) {
    return [
      finding("status_looks_decision", [row.id], {
        memory_type: row.memoryType,
        matched_terms: durable,
        suggested_type: "decision",
      }),
    ];
  }
  return [];
}

function taxonomyIssues(scopes: TagScopes, memoryType: string): string[] {
  const issues = (["area", "topic", "kind"] as const)
    .values()
    .filter((scope) => scopes[scope] === undefined)
    .map((scope) => `missing_${scope}`)
    .toArray();
  const type = memoryType.toLowerCase();
  if (scopes.kind !== undefined && scopes.kind !== type) {
    issues.push(`kind_mismatch:${scopes.kind}->${type}`);
  }
  return issues;
}

function suggestedTaxonomyTags(scopes: TagScopes, memoryType: string): string {
  const type = memoryType.toLowerCase();
  const seed = scopes.unscoped[0] ?? type;
  return [
    ...new Set([
      `area:${tagSegment(scopes.area ?? seed, "memory")}`,
      `topic:${tagSegment(scopes.topic ?? scopes.unscoped[1] ?? seed, type)}`,
      `kind:${tagSegment(type, type)}`,
      ...scopes.extraScoped,
    ]),
  ].join(",");
}

function tagFindings(row: DoctorRow): MemoryDoctorFinding[] {
  const tags = normalizeTags(row.tags);
  const normalized = tags.join(",");
  const base = { tags: row.tags, normalized_tags: normalized };
  if (normalized === "") {
    return [finding("empty_tags", [row.id], base)];
  }
  const findings =
    normalized === row.tags ? [] : [finding("invalid_tags", [row.id], base)];
  const scopes = tagScopes(tags);
  const issues = taxonomyIssues(scopes, row.memoryType);
  if (issues.length > 0) {
    findings.push(
      finding("taxonomy_mismatch", [row.id], {
        ...base,
        taxonomy_issues: issues,
        suggested_tags: suggestedTaxonomyTags(scopes, row.memoryType),
      }),
    );
  }
  return findings;
}

function stringsIn(values: readonly JsonValue[]): string[] {
  return values.flatMap((value) => {
    const text = jsonString(value);
    return text === undefined ? [] : [text];
  });
}

const StoredArraySchema = Schema.fromJsonString(Schema.Array(Schema.Json));

function parseStoredArray(text: string): readonly JsonValue[] | undefined {
  try {
    return Schema.decodeSync(StoredArraySchema)(text);
  } catch {
    return undefined;
  }
}

type RefsDiagnosis = { malformed: boolean; suggested: string[] };

/** Refs must be a JSON array of strings; suggests the recoverable strings. */
function refsDiagnosis(refs: JsonValue | undefined): RefsDiagnosis {
  if (Array.isArray(refs)) {
    const suggested = stringsIn(refs);
    return { malformed: suggested.length !== refs.length, suggested };
  }
  const text = jsonString(refs)?.trim();
  if (!text) {
    return { malformed: true, suggested: [] };
  }
  const parsed = parseStoredArray(text);
  if (parsed === undefined) {
    const split = text
      .split(",")
      .map((ref) => ref.trim())
      .filter(Boolean);
    return { malformed: true, suggested: split };
  }
  const suggested = stringsIn(parsed);
  return { malformed: suggested.length !== parsed.length, suggested };
}

function evidenceCount(evidence: JsonValue | undefined): number {
  if (Array.isArray(evidence)) {
    return evidence.length;
  }
  return parseStoredArray(jsonString(evidence) ?? "")?.length ?? 0;
}

function rowFindings(row: DoctorRow): MemoryDoctorFinding[] {
  const findings = [...tagFindings(row), ...typeBoundaryFindings(row)];
  const refs = refsDiagnosis(row.refs);
  if (refs.malformed) {
    findings.push(
      finding("malformed_refs", [row.id], {
        refs: row.refs ?? null,
        suggested_refs: refs.suggested,
      }),
    );
  }
  if (row.certainty === "verified" && evidenceCount(row.evidence) === 0) {
    // Legacy rows predate evidence; only a reviewer can say which kind applies.
    findings.push(
      finding("verified_without_evidence", [row.id], {
        hint: "Set the evidence kinds that were actually established, or lower certainty to inferred.",
      }),
    );
  }
  return findings;
}

function gotchaFindings(rows: readonly DoctorRow[]): MemoryDoctorFinding[] {
  return gotchaOverlaps(
    rows.map((row) => ({
      id: row.id,
      content: row.content,
      memory_type: row.memoryType,
    })),
  ).map((overlap) =>
    finding("gotcha_overlap", [...overlap.ids], {
      shared_identifiers: overlap.shared_identifiers,
      hint: "Consolidate the shared workaround into one gotcha; keep version-specific limits in their own record and reference it.",
    }),
  );
}

export function analyzeMemoryDoctor(
  repository: string,
  storedRows: readonly JsonObject[],
): MemoryDoctorResult {
  const rows = doctorRows(storedRows);
  const findings = [
    ...exactDuplicateFindings(rows),
    ...nearDuplicateFindings(rows),
    ...staleStatusFindings(rows),
    ...canonicalThreadFindings(rows),
    ...statusExpiryFindings(rows),
    ...rows.flatMap(rowFindings),
    ...gotchaFindings(rows),
  ];
  const countsByKind: Record<string, number> = {};
  for (const entry of findings) {
    countsByKind[entry.kind] = (countsByKind[entry.kind] ?? 0) + 1;
  }
  return {
    repository,
    checked: rows.length,
    count: findings.length,
    findings,
    counts_by_kind: countsByKind,
  };
}

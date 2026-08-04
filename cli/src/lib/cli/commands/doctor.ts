import { Effect } from "effect";
import { printJson } from "../../cli";
import type { MemoryDatabaseError } from "../../effect/database";
import { parseTags, stringValue, uniqueLowerPreserveOrder } from "../shared";
import { jaccardSimilarity, setFromTerms } from "../features/memory/compare";
import { requireDatabase, type CommandContext } from "../runtime/context";

type MemorySnapshot = {
  id: number;
  content: string;
  tagsRaw: string;
  memoContext: string;
  memoryType: string;
  refsRaw: unknown;
  expiresAfterDays: number | null;
  termSet: Set<string>;
};

type ExactDuplicateFinding = {
  kind: "exact_duplicate";
  keep_id: number;
  duplicate_ids: number[];
  suggested_command: string;
};

type NearDuplicateFinding = {
  kind: "near_duplicate";
  keep_id: number;
  duplicate_id: number;
  similarity: number;
  suggested_command: string;
};

type StaleStatusFinding = {
  kind: "stale_status_overlap";
  stale_id: number;
  superseded_by: number;
  shared_tags: string[];
  suggested_command: string;
};

type TagFinding = {
  kind: "empty_tags" | "invalid_tags" | "taxonomy_mismatch";
  id: number;
  tags: string;
  normalized_tags: string;
  taxonomy_issues?: string[];
  suggested_tags?: string;
  suggested_command: string;
};

type RefsFinding = {
  kind: "malformed_refs";
  id: number;
  refs: unknown;
  suggested_refs: string[];
  suggested_command: string;
};

type CanonicalThreadFinding = {
  kind: "canonical_thread_overlap";
  stale_id: number;
  canonical_id: number;
  thread_key: string;
  suggested_command: string;
};

type StatusExpiryFinding = {
  kind: "status_missing_expiry";
  id: number;
  expires_after_days: null;
  suggested_days: number;
  suggested_command: string;
};

type TypeBoundaryFinding = {
  kind: "transient_non_status" | "status_looks_decision";
  id: number;
  memory_type: string;
  matched_terms: string[];
  suggested_type: string;
  suggested_command: string;
};

type DoctorFindings = {
  exact_duplicates: ExactDuplicateFinding[];
  near_duplicates: NearDuplicateFinding[];
  stale_status_overlaps: StaleStatusFinding[];
  canonical_thread_overlaps: CanonicalThreadFinding[];
  status_expiry: StatusExpiryFinding[];
  type_boundary: TypeBoundaryFinding[];
  tag_hygiene: TagFinding[];
  malformed_refs: RefsFinding[];
};

const NEAR_DUPLICATE_THRESHOLD = 0.78;
const NEAR_DUPLICATE_MAX_CANDIDATES = 120;
const MAX_POSTINGS_PER_TOKEN = 200;
const DEFAULT_STATUS_EXPIRY_DAYS = 14;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function refsSuggestedPayload(refs: string[]): string {
  return shellQuote(JSON.stringify(refs));
}

function maybeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return null;
}

function loadActiveMemories(
  commandCtx: CommandContext,
): Effect.Effect<MemorySnapshot[], MemoryDatabaseError> {
  return requireDatabase(commandCtx)
    .all(
      `SELECT * FROM memories
       WHERE status = 'active'
       ORDER BY updated_at DESC, id DESC`,
    )
    .pipe(
      Effect.map((rows) =>
        (rows as Record<string, unknown>[]).map((row) => {
          const id = Number(row.id ?? 0);
          const content = stringValue(row.content);
          const tagsRaw = stringValue(row.tags);
          const memoContext = stringValue(row.context);
          return {
            id,
            content,
            tagsRaw,
            memoContext,
            memoryType: stringValue(row.memory_type),
            refsRaw: row.refs,
            expiresAfterDays: maybeInteger(row.expires_after_days),
            termSet: setFromTerms([content, tagsRaw, memoContext].join(" ")),
          };
        }),
      ),
    );
}

function exactDuplicateMap(
  rows: MemorySnapshot[],
): Map<string, MemorySnapshot[]> {
  const groups = new Map<string, MemorySnapshot[]>();
  for (const row of rows) {
    const key = [row.content, row.tagsRaw, row.memoContext].join("\u0001");
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  return groups;
}

function detectExactDuplicates(rows: MemorySnapshot[]): {
  findings: ExactDuplicateFinding[];
  duplicateKeyById: Map<number, string>;
} {
  const findings: ExactDuplicateFinding[] = [];
  const duplicateKeyById = new Map<number, string>();
  for (const [key, group] of exactDuplicateMap(rows)) {
    if (group.length <= 1) {
      continue;
    }
    const keep = group[0];
    if (!keep) {
      continue;
    }
    for (const entry of group) {
      duplicateKeyById.set(entry.id, key);
    }
    const duplicateIds = group.slice(1).map((entry) => entry.id);
    findings.push({
      kind: "exact_duplicate",
      keep_id: keep.id,
      duplicate_ids: duplicateIds,
      suggested_command: `machine-memory delete ${duplicateIds.join(",")}`,
    });
  }
  return { findings, duplicateKeyById };
}

function candidateIndexes(
  termSet: Set<string>,
  postings: Map<string, number[]>,
): number[] {
  const candidate = new Set<number>();
  const tokens = [...termSet].slice(0, 12);
  for (const token of tokens) {
    const indexes = postings.get(token);
    if (!indexes) {
      continue;
    }
    for (const index of indexes) {
      candidate.add(index);
      if (candidate.size >= NEAR_DUPLICATE_MAX_CANDIDATES) {
        return [...candidate];
      }
    }
  }
  return [...candidate];
}

function upsertPostings(
  postings: Map<string, number[]>,
  termSet: Set<string>,
  rowIndex: number,
) {
  for (const token of termSet) {
    const existing = postings.get(token) ?? [];
    if (existing.length < MAX_POSTINGS_PER_TOKEN) {
      existing.push(rowIndex);
      postings.set(token, existing);
    }
  }
}

function isComparableNearDuplicate(
  row: MemorySnapshot,
  candidate: MemorySnapshot | undefined,
  duplicateKeyById: Map<number, string>,
): candidate is MemorySnapshot {
  if (!candidate || candidate.id === row.id) {
    return false;
  }
  const leftKey = duplicateKeyById.get(row.id);
  const rightKey = duplicateKeyById.get(candidate.id);
  return !(leftKey && rightKey && leftKey === rightKey);
}

function bestNearDuplicateForRow(
  row: MemorySnapshot,
  rows: MemorySnapshot[],
  candidates: number[],
  duplicateKeyById: Map<number, string>,
): { id: number; similarity: number } | null {
  let best: { id: number; similarity: number } | null = null;
  for (const candidateIndex of candidates) {
    const candidate = rows[candidateIndex];
    if (!isComparableNearDuplicate(row, candidate, duplicateKeyById)) {
      continue;
    }
    const similarity = jaccardSimilarity(row.termSet, candidate.termSet);
    if (similarity < NEAR_DUPLICATE_THRESHOLD) {
      continue;
    }
    if (!best || similarity > best.similarity) {
      best = { id: candidate.id, similarity };
    }
  }
  return best;
}

function detectNearDuplicates(
  rows: MemorySnapshot[],
  duplicateKeyById: Map<number, string>,
): NearDuplicateFinding[] {
  const findings: NearDuplicateFinding[] = [];
  const postings = new Map<string, number[]>();

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || row.termSet.size === 0) {
      continue;
    }

    const best = bestNearDuplicateForRow(
      row,
      rows,
      candidateIndexes(row.termSet, postings),
      duplicateKeyById,
    );

    if (best) {
      findings.push({
        kind: "near_duplicate",
        keep_id: best.id,
        duplicate_id: row.id,
        similarity: best.similarity,
        suggested_command: `machine-memory deprecate ${row.id} --superseded-by ${best.id}`,
      });
    }

    upsertPostings(postings, row.termSet, rowIndex);
  }

  return findings;
}

function selectStatusMatch(tags: string[], latestByTag: Map<string, number>) {
  for (const tag of tags) {
    const match = latestByTag.get(tag);
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

function detectStaleStatusOverlaps(
  rows: MemorySnapshot[],
): StaleStatusFinding[] {
  const findings: StaleStatusFinding[] = [];
  const latestByTag = new Map<string, number>();

  for (const row of rows) {
    if (row.memoryType !== "status") {
      continue;
    }
    const normalizedTags = uniqueLowerPreserveOrder(
      parseTags(row.tagsRaw).map((tag) => tag.toLowerCase()),
    );
    if (normalizedTags.length === 0) {
      continue;
    }
    const newerId = selectStatusMatch(normalizedTags, latestByTag);
    if (newerId !== undefined) {
      const sharedTags = normalizedTags.filter(
        (tag) => latestByTag.get(tag) === newerId,
      );
      findings.push({
        kind: "stale_status_overlap",
        stale_id: row.id,
        superseded_by: newerId,
        shared_tags: sharedTags,
        suggested_command: `machine-memory deprecate ${row.id} --superseded-by ${newerId}`,
      });
    }
    for (const tag of normalizedTags) {
      if (!latestByTag.has(tag)) {
        latestByTag.set(tag, row.id);
      }
    }
  }

  return findings;
}

function normalizedTagValue(raw: string): string {
  return uniqueLowerPreserveOrder(parseTags(raw)).join(",");
}

type TagScopes = {
  area: string | undefined;
  topic: string | undefined;
  kind: string | undefined;
  extraScoped: string[];
  unscoped: string[];
};

function parseTagScopes(tags: string[]): TagScopes {
  const scopes: TagScopes = {
    area: undefined,
    topic: undefined,
    kind: undefined,
    extraScoped: [],
    unscoped: [],
  };

  for (const tag of tags) {
    const index = tag.indexOf(":");
    if (index <= 0 || index === tag.length - 1) {
      scopes.unscoped.push(tag);
      continue;
    }
    const namespace = tag.slice(0, index);
    const value = tag.slice(index + 1);
    switch (namespace) {
      case "area":
        if (!scopes.area) {
          scopes.area = value;
        } else {
          scopes.extraScoped.push(tag);
        }
        break;
      case "topic":
        if (!scopes.topic) {
          scopes.topic = value;
        } else {
          scopes.extraScoped.push(tag);
        }
        break;
      case "kind":
        if (!scopes.kind) {
          scopes.kind = value;
        } else {
          scopes.extraScoped.push(tag);
        }
        break;
      default:
        scopes.extraScoped.push(tag);
        break;
    }
  }

  return scopes;
}

function normalizeTagSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function taxonomySuggestionTags(row: MemorySnapshot): string {
  const normalizedTags = parseTags(normalizedTagValue(row.tagsRaw)).map((tag) =>
    tag.toLowerCase(),
  );
  const scopes = parseTagScopes(normalizedTags);
  const seed = scopes.unscoped[0] ?? row.memoryType.toLowerCase();
  const secondary = scopes.unscoped[1] ?? seed;
  const area = normalizeTagSegment(scopes.area ?? seed, "memory");
  const topic = normalizeTagSegment(
    scopes.topic ?? secondary,
    row.memoryType.toLowerCase(),
  );
  const kind = normalizeTagSegment(
    row.memoryType.toLowerCase(),
    row.memoryType.toLowerCase(),
  );
  return uniqueLowerPreserveOrder([
    `area:${area}`,
    `topic:${topic}`,
    `kind:${kind}`,
    ...scopes.extraScoped,
  ]).join(",");
}

function basicTagHygieneFindings(
  row: MemorySnapshot,
  normalized: string,
  contentArg: string,
): { findings: TagFinding[]; skipTaxonomy: boolean } {
  if (normalized.length === 0) {
    return {
      findings: [
        {
          kind: "empty_tags",
          id: row.id,
          tags: row.tagsRaw,
          normalized_tags: normalized,
          suggested_command: `machine-memory update ${row.id} ${contentArg} --tags "<tag1,tag2>"`,
        },
      ],
      skipTaxonomy: true,
    };
  }
  if (row.tagsRaw !== normalized) {
    return {
      findings: [
        {
          kind: "invalid_tags",
          id: row.id,
          tags: row.tagsRaw,
          normalized_tags: normalized,
          suggested_command: `machine-memory update ${row.id} ${contentArg} --tags ${shellQuote(normalized)}`,
        },
      ],
      skipTaxonomy: false,
    };
  }
  return { findings: [], skipTaxonomy: false };
}

function taxonomyIssuesForRow(
  row: MemorySnapshot,
  normalized: string,
): string[] {
  const normalizedTags = parseTags(normalized).map((tag) => tag.toLowerCase());
  const scopes = parseTagScopes(normalizedTags);
  const taxonomyIssues: string[] = [];
  if (!scopes.area) {
    taxonomyIssues.push("missing_area");
  }
  if (!scopes.topic) {
    taxonomyIssues.push("missing_topic");
  }
  if (!scopes.kind) {
    taxonomyIssues.push("missing_kind");
  }
  const lowerType = row.memoryType.toLowerCase();
  if (scopes.kind && scopes.kind !== lowerType) {
    taxonomyIssues.push(`kind_mismatch:${scopes.kind}->${lowerType}`);
  }
  return taxonomyIssues;
}

function taxonomyFinding(
  row: MemorySnapshot,
  normalized: string,
  contentArg: string,
): TagFinding | null {
  const taxonomyIssues = taxonomyIssuesForRow(row, normalized);
  if (taxonomyIssues.length === 0) {
    return null;
  }
  const suggestedTags = taxonomySuggestionTags(row);
  return {
    kind: "taxonomy_mismatch",
    id: row.id,
    tags: row.tagsRaw,
    normalized_tags: normalized,
    taxonomy_issues: taxonomyIssues,
    suggested_tags: suggestedTags,
    suggested_command: `machine-memory update ${row.id} ${contentArg} --tags ${shellQuote(suggestedTags)}`,
  };
}

function detectTagHygiene(rows: MemorySnapshot[]): TagFinding[] {
  const findings: TagFinding[] = [];

  for (const row of rows) {
    const normalized = normalizedTagValue(row.tagsRaw);
    const contentArg = shellQuote(row.content);
    const basic = basicTagHygieneFindings(row, normalized, contentArg);
    findings.push(...basic.findings);
    if (basic.skipTaxonomy) {
      continue;
    }
    const taxonomy = taxonomyFinding(row, normalized, contentArg);
    if (taxonomy) {
      findings.push(taxonomy);
    }
  }

  return findings;
}

function canonicalThreadKey(row: MemorySnapshot): string | null {
  const normalizedTags = parseTags(normalizedTagValue(row.tagsRaw)).map((tag) =>
    tag.toLowerCase(),
  );
  const scopes = parseTagScopes(normalizedTags);
  if (!scopes.topic) {
    return null;
  }
  const kind = normalizeTagSegment(
    scopes.kind ?? row.memoryType.toLowerCase(),
    row.memoryType.toLowerCase(),
  );
  const area = normalizeTagSegment(scopes.area ?? "global", "global");
  const topic = normalizeTagSegment(scopes.topic, "topic");
  return `${kind}|${area}|${topic}`;
}

function detectCanonicalThreadOverlaps(
  rows: MemorySnapshot[],
): CanonicalThreadFinding[] {
  const findings: CanonicalThreadFinding[] = [];
  const latestByThread = new Map<string, number>();

  for (const row of rows) {
    const threadKey = canonicalThreadKey(row);
    if (!threadKey) {
      continue;
    }
    const canonicalId = latestByThread.get(threadKey);
    if (canonicalId !== undefined) {
      findings.push({
        kind: "canonical_thread_overlap",
        stale_id: row.id,
        canonical_id: canonicalId,
        thread_key: threadKey,
        suggested_command: `machine-memory deprecate ${row.id} --superseded-by ${canonicalId}`,
      });
      continue;
    }
    latestByThread.set(threadKey, row.id);
  }

  return findings;
}

function detectStatusExpiry(rows: MemorySnapshot[]): StatusExpiryFinding[] {
  const findings: StatusExpiryFinding[] = [];
  for (const row of rows) {
    if (row.memoryType !== "status" || row.expiresAfterDays !== null) {
      continue;
    }
    findings.push({
      kind: "status_missing_expiry",
      id: row.id,
      expires_after_days: null,
      suggested_days: DEFAULT_STATUS_EXPIRY_DAYS,
      suggested_command: `machine-memory update ${row.id} ${shellQuote(row.content)} --expires-after-days ${DEFAULT_STATUS_EXPIRY_DAYS}`,
    });
  }
  return findings;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indicatorMatches(
  text: string,
  indicators: readonly string[],
): string[] {
  const matches: string[] = [];
  for (const indicator of indicators) {
    const matched = indicator.includes(" ")
      ? text.includes(indicator)
      : new RegExp(`\\b${escapeRegex(indicator)}\\b`).test(text);
    if (matched) {
      matches.push(indicator);
    }
  }
  return matches;
}

function detectTypeBoundary(rows: MemorySnapshot[]): TypeBoundaryFinding[] {
  const findings: TypeBoundaryFinding[] = [];
  for (const row of rows) {
    const text = [row.content, row.memoContext].join(" ").toLowerCase();
    const transientMatches = indicatorMatches(text, TRANSIENT_INDICATORS);
    const durableMatches = indicatorMatches(text, DURABLE_INDICATORS);
    const memoryType = row.memoryType.toLowerCase();
    if (memoryType !== "status" && transientMatches.length > 0) {
      findings.push({
        kind: "transient_non_status",
        id: row.id,
        memory_type: row.memoryType,
        matched_terms: transientMatches,
        suggested_type: "status",
        suggested_command: `machine-memory update ${row.id} ${shellQuote(row.content)} --type status --expires-after-days ${DEFAULT_STATUS_EXPIRY_DAYS}`,
      });
      continue;
    }
    if (
      memoryType === "status" &&
      durableMatches.length > 0 &&
      transientMatches.length === 0
    ) {
      findings.push({
        kind: "status_looks_decision",
        id: row.id,
        memory_type: row.memoryType,
        matched_terms: durableMatches,
        suggested_type: "decision",
        suggested_command: `machine-memory update ${row.id} ${shellQuote(row.content)} --type decision --expires-after-days null`,
      });
    }
  }
  return findings;
}

function parseMalformedRefs(raw: unknown): {
  malformed: boolean;
  suggested: string[];
} {
  if (Array.isArray(raw)) {
    const valid = raw.filter(
      (item): item is string => typeof item === "string",
    );
    return { malformed: valid.length !== raw.length, suggested: valid };
  }
  if (typeof raw !== "string") {
    return { malformed: true, suggested: [] };
  }
  if (raw.trim() === "") {
    return { malformed: true, suggested: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return { malformed: false, suggested: parsed as string[] };
    }
    if (Array.isArray(parsed)) {
      const normalized = parsed.filter(
        (item): item is string => typeof item === "string",
      );
      return { malformed: true, suggested: normalized };
    }
    return { malformed: true, suggested: [] };
  } catch {
    const split = raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return { malformed: true, suggested: split };
  }
}

function detectMalformedRefs(rows: MemorySnapshot[]): RefsFinding[] {
  const findings: RefsFinding[] = [];

  for (const row of rows) {
    const diagnosis = parseMalformedRefs(row.refsRaw);
    if (!diagnosis.malformed) {
      continue;
    }
    findings.push({
      kind: "malformed_refs",
      id: row.id,
      refs: row.refsRaw,
      suggested_refs: diagnosis.suggested,
      suggested_command: `machine-memory update ${row.id} ${shellQuote(row.content)} --refs ${refsSuggestedPayload(
        diagnosis.suggested,
      )}`,
    });
  }

  return findings;
}

function summarizeFindings(rows: MemorySnapshot[], findings: DoctorFindings) {
  const commandCount = collectSuggestedCommands(findings).length;
  return {
    checked: rows.length,
    exact_duplicates: findings.exact_duplicates.length,
    near_duplicates: findings.near_duplicates.length,
    stale_status_overlaps: findings.stale_status_overlaps.length,
    canonical_thread_overlaps: findings.canonical_thread_overlaps.length,
    status_missing_expiry: findings.status_expiry.length,
    type_boundary: findings.type_boundary.length,
    tag_hygiene: findings.tag_hygiene.length,
    malformed_refs: findings.malformed_refs.length,
    suggested_commands: commandCount,
  };
}

function collectSuggestedCommands(findings: DoctorFindings): string[] {
  const commands = [
    ...findings.exact_duplicates.map((item) => item.suggested_command),
    ...findings.near_duplicates.map((item) => item.suggested_command),
    ...findings.stale_status_overlaps.map((item) => item.suggested_command),
    ...findings.canonical_thread_overlaps.map((item) => item.suggested_command),
    ...findings.status_expiry.map((item) => item.suggested_command),
    ...findings.type_boundary.map((item) => item.suggested_command),
    ...findings.tag_hygiene.map((item) => item.suggested_command),
    ...findings.malformed_refs.map((item) => item.suggested_command),
  ];
  return uniqueLowerPreserveOrder(commands);
}

function printDoctorBrief(commands: string[]) {
  console.info(commands.join("\n"));
}

export function handleDoctorCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const rows = yield* loadActiveMemories(commandCtx);
    const exact = detectExactDuplicates(rows);
    const near = detectNearDuplicates(rows, exact.duplicateKeyById);
    const staleStatus = detectStaleStatusOverlaps(rows);
    const canonicalThread = detectCanonicalThreadOverlaps(rows);
    const statusExpiry = detectStatusExpiry(rows);
    const typeBoundary = detectTypeBoundary(rows);
    const tags = detectTagHygiene(rows);
    const refs = detectMalformedRefs(rows);
    const findings: DoctorFindings = {
      exact_duplicates: exact.findings,
      near_duplicates: near,
      stale_status_overlaps: staleStatus,
      canonical_thread_overlaps: canonicalThread,
      status_expiry: statusExpiry,
      type_boundary: typeBoundary,
      tag_hygiene: tags,
      malformed_refs: refs,
    };
    const suggestedCommands = collectSuggestedCommands(findings);
    const summary = summarizeFindings(rows, findings);
    yield* Effect.sync(() => {
      if (commandCtx.outputMode.jsonMin || commandCtx.outputMode.quiet) {
        printJson({
          count:
            summary.exact_duplicates +
            summary.near_duplicates +
            summary.stale_status_overlaps +
            summary.canonical_thread_overlaps +
            summary.status_missing_expiry +
            summary.type_boundary +
            summary.tag_hygiene +
            summary.malformed_refs,
          suggested_commands_count: suggestedCommands.length,
        });
        return;
      }
      if (commandCtx.outputMode.brief) {
        printDoctorBrief(suggestedCommands);
        return;
      }
      printJson({ summary, findings, suggested_commands: suggestedCommands });
    });
  });
}

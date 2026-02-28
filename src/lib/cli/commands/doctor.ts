import { printJson } from "../../cli";
import { allWithRetry } from "../../db";
import {
  jaccardSimilarity,
  parseTags,
  setFromTerms,
  stringValue,
  uniqueLowerPreserveOrder,
} from "../shared";
import type { CommandContext } from "./context";

type MemorySnapshot = {
  id: number;
  content: string;
  tagsRaw: string;
  memoContext: string;
  memoryType: string;
  refsRaw: unknown;
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
  kind: "empty_tags" | "invalid_tags";
  id: number;
  tags: string;
  normalized_tags: string;
  suggested_command: string;
};

type RefsFinding = {
  kind: "malformed_refs";
  id: number;
  refs: unknown;
  suggested_refs: string[];
  suggested_command: string;
};

type DoctorFindings = {
  exact_duplicates: ExactDuplicateFinding[];
  near_duplicates: NearDuplicateFinding[];
  stale_status_overlaps: StaleStatusFinding[];
  tag_hygiene: TagFinding[];
  malformed_refs: RefsFinding[];
};

const NEAR_DUPLICATE_THRESHOLD = 0.78;
const NEAR_DUPLICATE_MAX_CANDIDATES = 120;
const MAX_POSTINGS_PER_TOKEN = 200;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function refsSuggestedPayload(refs: string[]): string {
  return shellQuote(JSON.stringify(refs));
}

function loadActiveMemories(commandCtx: CommandContext): MemorySnapshot[] {
  const rows = allWithRetry(
    commandCtx.requireDb(),
    `SELECT * FROM memories
     WHERE status = 'active'
     ORDER BY updated_at DESC, id DESC`,
  ) as Record<string, unknown>[];

  return rows.map((row) => {
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
      termSet: setFromTerms([content, tagsRaw, memoContext].join(" ")),
    };
  });
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

function detectTagHygiene(rows: MemorySnapshot[]): TagFinding[] {
  const findings: TagFinding[] = [];

  for (const row of rows) {
    const normalized = normalizedTagValue(row.tagsRaw);
    const contentArg = shellQuote(row.content);
    if (normalized.length === 0) {
      findings.push({
        kind: "empty_tags",
        id: row.id,
        tags: row.tagsRaw,
        normalized_tags: normalized,
        suggested_command: `machine-memory update ${row.id} ${contentArg} --tags "<tag1,tag2>"`,
      });
      continue;
    }
    if (row.tagsRaw !== normalized) {
      findings.push({
        kind: "invalid_tags",
        id: row.id,
        tags: row.tagsRaw,
        normalized_tags: normalized,
        suggested_command: `machine-memory update ${row.id} ${contentArg} --tags ${shellQuote(normalized)}`,
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
    ...findings.tag_hygiene.map((item) => item.suggested_command),
    ...findings.malformed_refs.map((item) => item.suggested_command),
  ];
  return uniqueLowerPreserveOrder(commands);
}

function printDoctorBrief(commands: string[]) {
  console.info(commands.join("\n"));
}

export function handleDoctorCommand(commandCtx: CommandContext) {
  const rows = loadActiveMemories(commandCtx);
  const exact = detectExactDuplicates(rows);
  const near = detectNearDuplicates(rows, exact.duplicateKeyById);
  const staleStatus = detectStaleStatusOverlaps(rows);
  const tags = detectTagHygiene(rows);
  const refs = detectMalformedRefs(rows);

  const findings: DoctorFindings = {
    exact_duplicates: exact.findings,
    near_duplicates: near,
    stale_status_overlaps: staleStatus,
    tag_hygiene: tags,
    malformed_refs: refs,
  };

  const suggestedCommands = collectSuggestedCommands(findings);
  const summary = summarizeFindings(rows, findings);

  if (commandCtx.outputMode.jsonMin || commandCtx.outputMode.quiet) {
    printJson({
      count:
        summary.exact_duplicates +
        summary.near_duplicates +
        summary.stale_status_overlaps +
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

  printJson({
    summary,
    findings,
    suggested_commands: suggestedCommands,
  });
}

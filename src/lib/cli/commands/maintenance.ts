import { getFlagValue, printJson, usageError } from "../../cli";
import { allWithRetry, runWithRetry } from "../../db";
import {
  CERTAINTY_LEVELS,
  MEMORY_TYPES,
  type Certainty,
  type MemoryStatus,
  type MemoryType,
} from "../../constants";
import {
  applySqlFilters,
  assertFileExists,
  canonicalizeCertainty,
  collectDirectories,
  detectPotentialConflicts,
  findExactDuplicate,
  isMemoryStatus,
  isMemoryType,
  normalizeCertaintyValue,
  normalizeSqliteRow,
  parseCommonFilters,
  parseSinceDate,
  parseStoredRefs,
  parseTags,
  sqliteDateForComparison,
  sqliteDateToMs,
  stringValue,
} from "../shared";
import type { CommandContext } from "./context";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type ImportNormalized = {
  content: string;
  tags: string;
  memoContext: string;
  memoryTypeRaw: MemoryType;
  certaintyNormalized: Certainty;
  statusRaw: MemoryStatus;
  supersededBy: number | null;
  sourceAgent: string;
  lastUpdatedBy: string;
  updateCount: number;
  refs: string[];
  expiresAfterDays: number | null;
  createdAt?: string;
  updatedAt?: string;
};

type ImportSkip = {
  status: "skip";
  reason: string;
  extra?: Record<string, unknown>;
};

type ImportOk = {
  status: "ok";
  value: ImportNormalized;
};

type ImportParseResult = ImportSkip | ImportOk;

type StatsAccumulator = {
  byType: Record<string, number>;
  byCertainty: Record<string, number>;
  tagFrequency: Record<string, number>;
  oldest: Record<string, unknown> | null;
  staleCount: number;
  noTagsCount: number;
  now: number;
};

function importSkip(
  reason: string,
  extra?: Record<string, unknown>,
): ImportSkip {
  return { status: "skip", reason, extra };
}

function importObject(rawEntry: unknown): Record<string, unknown> | null {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return null;
  }
  return rawEntry as Record<string, unknown>;
}

function parseImportContent(
  entry: Record<string, unknown>,
): string | undefined {
  const content = typeof entry.content === "string" ? entry.content : "";
  return content || undefined;
}

function parseImportEnums(entry: Record<string, unknown>):
  | {
      memoryTypeRaw: MemoryType;
      certaintyNormalized: Certainty;
      statusRaw: MemoryStatus;
    }
  | ImportSkip {
  const memoryTypeRaw =
    typeof entry.memory_type === "string" ? entry.memory_type : "convention";
  const certaintyRaw =
    typeof entry.certainty === "string" ? entry.certainty : "inferred";
  const certaintyNormalized = canonicalizeCertainty(certaintyRaw);
  const statusRaw = typeof entry.status === "string" ? entry.status : "active";

  if (!isMemoryType(memoryTypeRaw)) {
    return importSkip("invalid_memory_type", { memory_type: memoryTypeRaw });
  }
  if (!certaintyNormalized) {
    return importSkip("invalid_certainty", { certainty: certaintyRaw });
  }
  if (!isMemoryStatus(statusRaw)) {
    return importSkip("invalid_status", { status_value: statusRaw });
  }

  return {
    memoryTypeRaw,
    certaintyNormalized,
    statusRaw,
  };
}

function parseImportRefs(entry: Record<string, unknown>): string[] {
  if (Array.isArray(entry.refs)) {
    return entry.refs.filter(
      (item): item is string => typeof item === "string",
    );
  }
  if (typeof entry.refs === "string") {
    return parseStoredRefs(entry.refs);
  }
  return [];
}

function parseImportTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  return sqliteDateForComparison(value);
}

function parseImportMetadata(entry: Record<string, unknown>) {
  const sourceAgent =
    typeof entry.source_agent === "string" ? entry.source_agent : "";
  const lastUpdatedBy =
    typeof entry.last_updated_by === "string"
      ? entry.last_updated_by
      : sourceAgent;
  const updateCount =
    typeof entry.update_count === "number" &&
    Number.isInteger(entry.update_count)
      ? entry.update_count
      : 0;
  return {
    tags: typeof entry.tags === "string" ? entry.tags : "",
    memoContext: typeof entry.context === "string" ? entry.context : "",
    supersededBy:
      typeof entry.superseded_by === "number" &&
      Number.isInteger(entry.superseded_by)
        ? entry.superseded_by
        : null,
    sourceAgent,
    lastUpdatedBy,
    updateCount,
    refs: parseImportRefs(entry),
    expiresAfterDays:
      typeof entry.expires_after_days === "number" &&
      Number.isInteger(entry.expires_after_days)
        ? entry.expires_after_days
        : null,
    createdAt: parseImportTimestamp(entry.created_at),
    updatedAt: parseImportTimestamp(entry.updated_at),
  };
}

function normalizeImportEntry(rawEntry: unknown): ImportParseResult {
  const entry = importObject(rawEntry);
  if (!entry) {
    return importSkip("invalid_entry");
  }

  const content = parseImportContent(entry);
  if (!content) {
    return importSkip("missing_content");
  }

  const enums = parseImportEnums(entry);
  if ("status" in enums) {
    return enums;
  }

  const metadata = parseImportMetadata(entry);
  return {
    status: "ok",
    value: {
      content,
      ...enums,
      ...metadata,
    },
  };
}

function runImportInsert(
  database: ReturnType<CommandContext["requireDb"]>,
  value: ImportNormalized,
) {
  if (value.createdAt && value.updatedAt) {
    return runWithRetry(
      database,
      `INSERT INTO memories (
       content, tags, context, memory_type, status, superseded_by, source_agent,
       last_updated_by, update_count, certainty, refs, expires_after_days,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        value.content,
        value.tags,
        value.memoContext,
        value.memoryTypeRaw,
        value.statusRaw,
        value.supersededBy,
        value.sourceAgent,
        value.lastUpdatedBy,
        value.updateCount,
        value.certaintyNormalized,
        JSON.stringify(value.refs),
        value.expiresAfterDays,
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  return runWithRetry(
    database,
    `INSERT INTO memories (
     content, tags, context, memory_type, status, superseded_by, source_agent,
     last_updated_by, update_count, certainty, refs, expires_after_days
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      value.content,
      value.tags,
      value.memoContext,
      value.memoryTypeRaw,
      value.statusRaw,
      value.supersededBy,
      value.sourceAgent,
      value.lastUpdatedBy,
      value.updateCount,
      value.certaintyNormalized,
      JSON.stringify(value.refs),
      value.expiresAfterDays,
    ],
  );
}

function parseImportFile(path: string | undefined): unknown[] {
  if (!path) {
    usageError("Usage: import <memories.json>");
  }
  const filePath = assertFileExists(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  } catch (parseError) {
    printJson({
      error: `Failed to parse JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
    });
    process.exit(1);
  }

  if (!Array.isArray(parsed)) {
    usageError("Import file must contain a JSON array.");
  }

  return parsed;
}

function createStatsAccumulator(): StatsAccumulator {
  return {
    byType: Object.fromEntries(MEMORY_TYPES.map((type) => [type, 0])),
    byCertainty: Object.fromEntries(
      CERTAINTY_LEVELS.map((level) => [level, 0]),
    ),
    tagFrequency: {},
    oldest: null,
    staleCount: 0,
    noTagsCount: 0,
    now: Date.now(),
  };
}

function updateOldest(
  current: Record<string, unknown> | null,
  candidate: Record<string, unknown>,
) {
  if (!current) {
    return candidate;
  }
  const candidateAge =
    sqliteDateToMs(candidate.created_at) ?? Number.POSITIVE_INFINITY;
  const currentAge =
    sqliteDateToMs(current.created_at) ?? Number.POSITIVE_INFINITY;
  return candidateAge < currentAge ? candidate : current;
}

function updateStaleCount(
  accumulator: StatsAccumulator,
  memory: Record<string, unknown>,
) {
  const updatedMs = sqliteDateToMs(memory.updated_at);
  if (updatedMs === null) {
    return;
  }
  const ageDays = (accumulator.now - updatedMs) / (1000 * 60 * 60 * 24);
  if (ageDays > 90) {
    accumulator.staleCount += 1;
  }
}

function ingestMemoryStats(
  accumulator: StatsAccumulator,
  memory: Record<string, unknown>,
) {
  const type = stringValue(memory.memory_type, "convention");
  accumulator.byType[type] = (accumulator.byType[type] ?? 0) + 1;

  const certainty = normalizeCertaintyValue(memory.certainty);
  accumulator.byCertainty[certainty] =
    (accumulator.byCertainty[certainty] ?? 0) + 1;

  const tags = parseTags(stringValue(memory.tags));
  if (tags.length === 0) {
    accumulator.noTagsCount += 1;
  }
  for (const tag of tags) {
    accumulator.tagFrequency[tag] = (accumulator.tagFrequency[tag] ?? 0) + 1;
  }

  accumulator.oldest = updateOldest(accumulator.oldest, memory);
  updateStaleCount(accumulator, memory);
}

function processImportEntry(
  database: ReturnType<CommandContext["requireDb"]>,
  index: number,
  rawEntry: unknown,
): Record<string, unknown> {
  const normalized = normalizeImportEntry(rawEntry);
  if (normalized.status === "skip") {
    return {
      index,
      status: "skip",
      reason: normalized.reason,
      ...normalized.extra,
    };
  }

  const value = normalized.value;
  const duplicate = findExactDuplicate(database, {
    content: value.content,
    tags: value.tags,
    context: value.memoContext,
  });
  if (duplicate) {
    return {
      index,
      status: "skip",
      reason: "exact_duplicate",
      existing_id: duplicate.id,
    };
  }

  const conflicts =
    value.statusRaw === "active"
      ? detectPotentialConflicts(database, {
          content: value.content,
          tags: value.tags,
          context: value.memoContext,
        })
      : [];
  if (conflicts.length > 0) {
    return {
      index,
      status: "conflict",
      potential_conflicts: conflicts,
    };
  }

  const insert = runImportInsert(database, value);
  return { index, status: "success", id: insert.lastInsertRowid };
}

export function handleCoverageCommand(commandCtx: CommandContext) {
  const { args, requireDb } = commandCtx;
  const database = requireDb();
  const root = resolve(process.cwd(), getFlagValue(args, "--root") ?? ".");
  const directories = collectDirectories(root);
  const rows = allWithRetry(
    database,
    "SELECT tags FROM memories WHERE status = 'active'",
  ) as { tags?: unknown }[];

  const tagDistribution: Record<string, number> = {};
  const tagSet = new Set<string>();
  for (const row of rows) {
    const tags = parseTags(stringValue(row.tags));
    for (const tag of tags) {
      tagDistribution[tag] = (tagDistribution[tag] ?? 0) + 1;
      tagSet.add(tag.toLowerCase());
    }
  }

  const uncoveredPaths = directories.filter((dir) => {
    const parts = dir
      .replace(/\/$/, "")
      .split("/")
      .map((part) => part.toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) {
      return false;
    }
    return !parts.some((part) => tagSet.has(part));
  });

  printJson({
    root,
    uncovered_paths: uncoveredPaths,
    tag_distribution: tagDistribution,
  });
}

export function handleGcCommand(commandCtx: CommandContext) {
  const { args, requireDb } = commandCtx;
  const database = requireDb();
  const dryRun = args.includes("--dry-run");
  if (!dryRun) {
    usageError("Usage: gc --dry-run");
  }
  const rows = allWithRetry(
    database,
    `SELECT * FROM memories
     WHERE status = 'active'
       AND expires_after_days IS NOT NULL
       AND datetime(updated_at, '+' || expires_after_days || ' days') <= datetime('now')
     ORDER BY updated_at ASC`,
  );
  const expired = (rows as unknown[]).map((row) => normalizeSqliteRow(row));
  printJson({ dry_run: true, count: expired.length, expired });
}

export function handleStatsCommand(commandCtx: CommandContext) {
  const rows = allWithRetry(
    commandCtx.requireDb(),
    "SELECT * FROM memories",
  ) as unknown[];
  const memories = rows.map((row) => normalizeSqliteRow(row));
  const accumulator = createStatsAccumulator();
  for (const memory of memories) {
    ingestMemoryStats(accumulator, memory);
  }

  printJson({
    total_memories: memories.length,
    breakdown_by_memory_type: accumulator.byType,
    breakdown_by_certainty: accumulator.byCertainty,
    tag_frequency_map: accumulator.tagFrequency,
    oldest_memory: accumulator.oldest,
    memories_not_updated_over_90_days: accumulator.staleCount,
    memories_with_no_tags: accumulator.noTagsCount,
  });
}

export function handleImportCommand(commandCtx: CommandContext) {
  const database = commandCtx.requireDb();
  const parsed = parseImportFile(commandCtx.args[0]);
  const results: Record<string, unknown>[] = [];
  for (const [index, rawEntry] of parsed.entries()) {
    results.push(processImportEntry(database, index, rawEntry));
  }
  printJson({ results });
}

export function handleExportCommand(commandCtx: CommandContext) {
  const { args, requireDb } = commandCtx;
  const database = requireDb();
  const filters = parseCommonFilters(args);
  const since = parseSinceDate(args);
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  applySqlFilters(clauses, params, filters, { defaultActiveOnly: true });
  if (since) {
    clauses.push("updated_at >= ?");
    params.push(sqliteDateForComparison(since));
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = allWithRetry(
    database,
    `SELECT * FROM memories ${where} ORDER BY updated_at DESC, id DESC`,
    params,
  );
  printJson((rows as unknown[]).map((row) => normalizeSqliteRow(row)));
}

export function handleMigrateCommand() {
  printJson({ status: "ok", migrated: true });
}

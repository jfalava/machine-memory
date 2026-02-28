/* eslint-disable max-statements, complexity */
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
  applySqlFilters,
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

function normalizeImportEntry(
  rawEntry: unknown,
):
  | { status: "skip"; reason: string; extra?: Record<string, unknown> }
  | { status: "ok"; value: ImportNormalized } {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return { status: "skip", reason: "invalid_entry" };
  }

  const entry = rawEntry as Record<string, unknown>;
  const content = typeof entry.content === "string" ? entry.content : "";
  if (!content) {
    return { status: "skip", reason: "missing_content" };
  }

  const tags = typeof entry.tags === "string" ? entry.tags : "";
  const memoContext = typeof entry.context === "string" ? entry.context : "";
  const memoryTypeRaw =
    typeof entry.memory_type === "string" ? entry.memory_type : "convention";
  const certaintyRaw =
    typeof entry.certainty === "string" ? entry.certainty : "inferred";
  const certaintyNormalized = canonicalizeCertainty(certaintyRaw);
  const statusRaw = typeof entry.status === "string" ? entry.status : "active";

  if (!isMemoryType(memoryTypeRaw)) {
    return {
      status: "skip",
      reason: "invalid_memory_type",
      extra: { memory_type: memoryTypeRaw },
    };
  }
  if (!certaintyNormalized) {
    return {
      status: "skip",
      reason: "invalid_certainty",
      extra: { certainty: certaintyRaw },
    };
  }
  if (!isMemoryStatus(statusRaw)) {
    return {
      status: "skip",
      reason: "invalid_status",
      extra: { status_value: statusRaw },
    };
  }

  const supersededBy =
    typeof entry.superseded_by === "number" &&
    Number.isInteger(entry.superseded_by)
      ? entry.superseded_by
      : null;
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
  const refs = Array.isArray(entry.refs)
    ? entry.refs.filter((item): item is string => typeof item === "string")
    : typeof entry.refs === "string"
      ? parseStoredRefs(entry.refs)
      : [];
  const expiresAfterDays =
    typeof entry.expires_after_days === "number" &&
    Number.isInteger(entry.expires_after_days)
      ? entry.expires_after_days
      : null;
  const createdAt =
    typeof entry.created_at === "string" &&
    !Number.isNaN(Date.parse(entry.created_at))
      ? sqliteDateForComparison(entry.created_at)
      : undefined;
  const updatedAt =
    typeof entry.updated_at === "string" &&
    !Number.isNaN(Date.parse(entry.updated_at))
      ? sqliteDateForComparison(entry.updated_at)
      : undefined;

  return {
    status: "ok",
    value: {
      content,
      tags,
      memoContext,
      memoryTypeRaw,
      certaintyNormalized,
      statusRaw,
      supersededBy,
      sourceAgent,
      lastUpdatedBy,
      updateCount,
      refs,
      expiresAfterDays,
      createdAt,
      updatedAt,
    },
  };
}

function runImportInsert(
  database: CommandContext["requireDb"],
  value: ImportNormalized,
) {
  const databaseInstance = database();
  if (value.createdAt && value.updatedAt) {
    return runWithRetry(
      databaseInstance,
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
    databaseInstance,
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
  const { requireDb } = commandCtx;
  const database = requireDb();
  const rows = allWithRetry(database, "SELECT * FROM memories") as unknown[];
  const memories = rows.map((row) => normalizeSqliteRow(row));

  const byType: Record<string, number> = Object.fromEntries(
    MEMORY_TYPES.map((type) => [type, 0]),
  );
  const byCertainty: Record<string, number> = Object.fromEntries(
    CERTAINTY_LEVELS.map((level) => [level, 0]),
  );
  const tagFrequency: Record<string, number> = {};

  let oldest: Record<string, unknown> | null = null;
  let staleCount = 0;
  let noTagsCount = 0;
  const now = Date.now();

  for (const memory of memories) {
    const type = stringValue(memory.memory_type, "convention");
    byType[type] = (byType[type] ?? 0) + 1;

    const certainty = normalizeCertaintyValue(memory.certainty);
    byCertainty[certainty] = (byCertainty[certainty] ?? 0) + 1;

    const tags = parseTags(stringValue(memory.tags));
    if (tags.length === 0) {
      noTagsCount += 1;
    }
    for (const tag of tags) {
      tagFrequency[tag] = (tagFrequency[tag] ?? 0) + 1;
    }

    if (
      !oldest ||
      (sqliteDateToMs(memory.created_at) ?? Number.POSITIVE_INFINITY) <
        (sqliteDateToMs(oldest.created_at) ?? Number.POSITIVE_INFINITY)
    ) {
      oldest = memory;
    }

    const updatedMs = sqliteDateToMs(memory.updated_at);
    if (updatedMs === null) {
      continue;
    }
    const ageDays = (now - updatedMs) / (1000 * 60 * 60 * 24);
    if (ageDays > 90) {
      staleCount += 1;
    }
  }

  printJson({
    total_memories: memories.length,
    breakdown_by_memory_type: byType,
    breakdown_by_certainty: byCertainty,
    tag_frequency_map: tagFrequency,
    oldest_memory: oldest,
    memories_not_updated_over_90_days: staleCount,
    memories_with_no_tags: noTagsCount,
  });
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

export function handleImportCommand(commandCtx: CommandContext) {
  const { args, requireDb } = commandCtx;
  const database = requireDb();
  const parsed = parseImportFile(args[0]);
  const results: Record<string, unknown>[] = [];

  for (const [index, rawEntry] of parsed.entries()) {
    const normalized = normalizeImportEntry(rawEntry);
    if (normalized.status === "skip") {
      results.push({
        index,
        status: "skip",
        reason: normalized.reason,
        ...normalized.extra,
      });
      continue;
    }

    const value = normalized.value;
    const duplicate = findExactDuplicate(database, {
      content: value.content,
      tags: value.tags,
      context: value.memoContext,
    });
    if (duplicate) {
      results.push({
        index,
        status: "skip",
        reason: "exact_duplicate",
        existing_id: duplicate.id,
      });
      continue;
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
      results.push({
        index,
        status: "conflict",
        potential_conflicts: conflicts,
      });
      continue;
    }

    const insert = runImportInsert(requireDb, value);
    results.push({ index, status: "success", id: insert.lastInsertRowid });
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

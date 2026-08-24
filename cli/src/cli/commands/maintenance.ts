import { Effect } from "effect";
import type {
  MemoryDatabaseApi,
  MemoryDatabaseError,
} from "../../effect/database";
import {
  CERTAINTY_LEVELS,
  MEMORY_TYPES,
  type Certainty,
  type MemoryStatus,
  type MemoryType,
} from "../../constants";
import {
  jsonNumber,
  jsonObject,
  jsonString,
  jsonStringArray,
  isJsonArray,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "../../json";
import {
  canonicalizeCertainty,
  detectPotentialConflicts,
  findExactDuplicate,
  getMemoryById,
  isMemoryStatus,
  isMemoryType,
  normalizeCertaintyValue,
  normalizeSqliteRow,
  parseStoredRefs,
  parseTags,
  sqliteDateForComparison,
  sqliteDateToMs,
  stringValue,
} from "../shared";
import { syncMemoryVector } from "../../effect/vector-sync";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { repositoryForCurrentDirectory } from "../../repository";
import { resolve } from "node:path";
import { printJson, usageError } from "../../cli-utils";
import { hasMinimalOutput, printCommandOutput } from "../runtime/output";

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
  extra?: JsonObject;
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
  oldest: JsonObject | null;
  staleCount: number;
  noTagsCount: number;
  now: number;
};

function importSkip(reason: string, extra?: JsonObject): ImportSkip {
  return { status: "skip", reason, extra };
}

function importObject(rawEntry: JsonValue): JsonObject | null {
  return jsonObject(rawEntry) ?? null;
}

function parseImportContent(entry: JsonObject): string | undefined {
  const content = jsonString(entry.content) ?? "";
  return content || undefined;
}

function parseImportEnums(entry: JsonObject):
  | {
      memoryTypeRaw: MemoryType;
      certaintyNormalized: Certainty;
      statusRaw: MemoryStatus;
    }
  | ImportSkip {
  const memoryTypeRaw = jsonString(entry.memory_type) ?? "convention";
  const certaintyRaw = jsonString(entry.certainty) ?? "inferred";
  const certaintyNormalized = canonicalizeCertainty(certaintyRaw);
  const statusRaw = jsonString(entry.status) ?? "active";

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

function parseImportRefs(entry: JsonObject): string[] {
  const refs = jsonStringArray(entry.refs);
  if (refs !== undefined) {
    return refs;
  }
  const raw = jsonString(entry.refs);
  return raw === undefined ? [] : parseStoredRefs(raw);
}

function parseImportTimestamp(
  value: JsonValue | undefined,
): string | undefined {
  const raw = jsonString(value);
  if (raw === undefined || Number.isNaN(Date.parse(raw))) {
    return undefined;
  }
  return sqliteDateForComparison(raw);
}

function parseImportMetadata(entry: JsonObject) {
  const sourceAgent = jsonString(entry.source_agent) ?? "";
  const lastUpdatedBy = jsonString(entry.last_updated_by) ?? sourceAgent;
  const parsedUpdateCount = jsonNumber(entry.update_count);
  const updateCount =
    parsedUpdateCount !== undefined && Number.isInteger(parsedUpdateCount)
      ? parsedUpdateCount
      : 0;
  const parsedSupersededBy = jsonNumber(entry.superseded_by);
  const parsedExpiresAfterDays = jsonNumber(entry.expires_after_days);
  return {
    tags: jsonString(entry.tags) ?? "",
    memoContext: jsonString(entry.context) ?? "",
    supersededBy:
      parsedSupersededBy !== undefined && Number.isInteger(parsedSupersededBy)
        ? parsedSupersededBy
        : null,
    sourceAgent,
    lastUpdatedBy,
    updateCount,
    refs: parseImportRefs(entry),
    expiresAfterDays:
      parsedExpiresAfterDays !== undefined &&
      Number.isInteger(parsedExpiresAfterDays)
        ? parsedExpiresAfterDays
        : null,
    createdAt: parseImportTimestamp(entry.created_at),
    updatedAt: parseImportTimestamp(entry.updated_at),
  };
}

function normalizeImportEntry(rawEntry: JsonValue): ImportParseResult {
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
  database: MemoryDatabaseApi,
  value: ImportNormalized,
): Effect.Effect<JsonValue, MemoryDatabaseError> {
  if (value.createdAt && value.updatedAt) {
    return database.run(
      `INSERT INTO memories (
       repository, content, tags, context, memory_type, status, superseded_by, source_agent,
       last_updated_by, update_count, certainty, refs, expires_after_days,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        repositoryForCurrentDirectory(),
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

  return database.run(
    `INSERT INTO memories (
     repository, content, tags, context, memory_type, status, superseded_by, source_agent,
     last_updated_by, update_count, certainty, refs, expires_after_days
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      repositoryForCurrentDirectory(),
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

function parseImportFile(
  path: string | undefined,
  fileSystem: CommandContext["fileSystem"],
): Effect.Effect<JsonValue[], unknown> {
  if (!path) {
    usageError("Usage: import <memories.json>");
  }
  const filePath = resolve(process.cwd(), path);
  return Effect.gen(function* () {
    if (!(yield* fileSystem.exists(filePath))) {
      usageError(`File not found: ${path}`);
    }
    const raw = yield* fileSystem.readFileString(filePath);
    const parsed = yield* Effect.try({
      try: (): JsonValue => parseJson(raw),
      catch: (cause) => new Error(`Failed to parse JSON: ${String(cause)}`),
    });
    if (!isJsonArray(parsed)) {
      usageError("Import file must contain a JSON array.");
    }
    return [...parsed];
  });
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

function updateOldest(current: JsonObject | null, candidate: JsonObject) {
  if (!current) {
    return candidate;
  }
  const candidateAge =
    sqliteDateToMs(candidate.created_at) ?? Number.POSITIVE_INFINITY;
  const currentAge =
    sqliteDateToMs(current.created_at) ?? Number.POSITIVE_INFINITY;
  return candidateAge < currentAge ? candidate : current;
}

function updateStaleCount(accumulator: StatsAccumulator, memory: JsonObject) {
  const updatedMs = sqliteDateToMs(memory.updated_at);
  if (updatedMs === null) {
    return;
  }
  const ageDays = (accumulator.now - updatedMs) / (1000 * 60 * 60 * 24);
  if (ageDays > 90) {
    accumulator.staleCount += 1;
  }
}

function ingestMemoryStats(accumulator: StatsAccumulator, memory: JsonObject) {
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
  database: MemoryDatabaseApi,
  index: number,
  rawEntry: JsonValue,
): Effect.Effect<JsonObject, MemoryDatabaseError> {
  const normalized = normalizeImportEntry(rawEntry);
  if (normalized.status === "skip") {
    return Effect.succeed({
      index,
      status: "skip",
      reason: normalized.reason,
      ...normalized.extra,
    } satisfies JsonObject);
  }

  const value = normalized.value;
  return Effect.gen(function* () {
    const duplicate = yield* findExactDuplicate(database, {
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
      } satisfies JsonObject;
    }
    const conflicts =
      value.statusRaw === "active"
        ? yield* detectPotentialConflicts(database, {
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
      } satisfies JsonObject;
    }
    const insert = yield* runImportInsert(database, value);
    return {
      index,
      status: "success",
      id: jsonObject(insert)?.lastInsertRowid ?? null,
    } satisfies JsonObject;
  });
}

export function handleStatsCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const rows = yield* requireDatabase(commandCtx).all(
      "SELECT * FROM memories WHERE repository = ?",
      [repositoryForCurrentDirectory()],
    );
    const memories = rows.map((row) => normalizeSqliteRow(row));
    const accumulator = createStatsAccumulator();
    for (const memory of memories) {
      ingestMemoryStats(accumulator, memory);
    }
    yield* Effect.sync(() => {
      if (commandCtx.outputMode.quiet) {
        return;
      }
      printCommandOutput(commandCtx, {
        total_memories: memories.length,
        breakdown_by_memory_type: accumulator.byType,
        breakdown_by_certainty: accumulator.byCertainty,
        tag_frequency_map: accumulator.tagFrequency,
        oldest_memory: accumulator.oldest,
        memories_not_updated_over_90_days: accumulator.staleCount,
        memories_with_no_tags: accumulator.noTagsCount,
      });
    });
  });
}

export function handleImportCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const parsed = yield* parseImportFile(
      commandCtx.args[0],
      commandCtx.fileSystem,
    );
    const results: JsonObject[] = [];
    const database = requireDatabase(commandCtx);
    for (const [index, rawEntry] of parsed.entries()) {
      const result = yield* processImportEntry(database, index, rawEntry);
      results.push(result);
      if (result.status === "success") {
        const id = Number(result.id);
        const memory = yield* getMemoryById(database, id);
        if (memory) {
          yield* syncMemoryVector(database, memory);
        }
      }
    }
    yield* Effect.sync(() => {
      if (commandCtx.outputMode.quiet) {
        return;
      }
      if (hasMinimalOutput(commandCtx.outputMode)) {
        printJson({
          imported: results.filter((result) => result.status === "success")
            .length,
          failed: results.filter((result) => result.status !== "success")
            .length,
          count: results.length,
        });
        return;
      }
      printCommandOutput(commandCtx, { results });
    });
  });
}

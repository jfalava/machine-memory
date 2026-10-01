import { resolve } from "node:path";

import { Effect, Schema } from "effect";

import { printJson, usageError } from "../../cli-utils";
import {
  CERTAINTY_LEVELS,
  MEMORY_TYPES,
  type Certainty,
  type MemoryStatus,
  type MemoryType,
} from "../../constants";
import { assertBgeBreakdown } from "../../effect/bge-tokenizer";
import type {
  MemoryDatabaseApi,
  MemoryDatabaseError,
} from "../../effect/database";
import { commandError, type CommandError } from "../../effect/errors";
import { memoryVectorEmbeddingParts } from "../../effect/vectorize";
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
import { repositoryForCurrentDirectory } from "../../repository";
import { measureEmbeddingFit } from "../features/memory/size-report";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { hasMinimalOutput, printCommandOutput } from "../runtime/output";
import {
  canonicalizeCertainty,
  detectPotentialConflicts,
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

const positiveImportInt = Schema.Int.check(Schema.isGreaterThan(0));
const ImportMetadataSchema = Schema.Struct({
  id: Schema.optionalKey(positiveImportInt),
  superseded_by: Schema.optionalKey(Schema.NullOr(positiveImportInt)),
  update_count: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  expires_after_days: Schema.optionalKey(Schema.NullOr(positiveImportInt)),
  tags: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.String),
  memory_type: Schema.optionalKey(Schema.String),
  certainty: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  source_agent: Schema.optionalKey(Schema.String),
  last_updated_by: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(Schema.String),
  refs: Schema.optionalKey(
    Schema.Union([
      Schema.Array(Schema.String),
      Schema.fromJsonString(Schema.Array(Schema.String)),
    ]),
  ),
});

function validateImportMetadata(entry: JsonObject): ImportSkip | undefined {
  try {
    Schema.decodeUnknownSync(ImportMetadataSchema)(entry);
  } catch {
    return importSkip("invalid_metadata");
  }
  for (const field of ["created_at", "updated_at"]) {
    if (entry[field] !== undefined && !parseImportTimestamp(entry[field])) {
      return importSkip(`invalid_${field}`);
    }
  }
  return undefined;
}

function normalizeImportEntry(rawEntry: JsonValue): ImportParseResult {
  const entry = importObject(rawEntry);
  if (!entry) {
    return importSkip("invalid_entry");
  }
  const invalid = validateImportMetadata(entry);
  if (invalid) {
    return invalid;
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
  if (metadata.expiresAfterDays !== null && enums.memoryTypeRaw !== "status") {
    return importSkip("expiry_requires_status");
  }
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
  const columns = [
    "repository",
    "content",
    "tags",
    "context",
    "memory_type",
    "status",
    "superseded_by",
    "source_agent",
    "last_updated_by",
    "update_count",
    "certainty",
    "refs",
    "expires_after_days",
  ];
  const params: (string | number | null)[] = [
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
  ];
  if (value.createdAt) {
    columns.push("created_at");
    params.push(value.createdAt);
  }
  if (value.updatedAt) {
    columns.push("updated_at");
    params.push(value.updatedAt);
  }
  return database.run(
    `INSERT INTO memories (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params,
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
      catch: (cause) =>
        commandError("import", `Failed to parse JSON: ${String(cause)}`, cause),
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

type ImportPlan = {
  index: number;
  value: ImportNormalized;
  sourceId?: number;
  sourceRepository: string;
  targetId?: number;
  replacement?: ImportPlan;
};

function preflightImport(
  database: MemoryDatabaseApi,
  parsed: JsonValue[],
  results: JsonObject[],
): Effect.Effect<ImportPlan[], MemoryDatabaseError | CommandError> {
  return Effect.gen(function* () {
    const plans: ImportPlan[] = [],
      sources = new Map<number, ImportPlan>();
    for (const [index, rawEntry] of parsed.entries()) {
      const normalized = normalizeImportEntry(rawEntry);
      if (normalized.status === "skip") {
        results[index] = {
          index,
          status: "skip",
          reason: normalized.reason,
          ...normalized.extra,
        };
        return yield* commandError(
          "import",
          `Import preflight failed at index ${index}: ${normalized.reason}`,
        );
      }
      const plan: ImportPlan = {
        index,
        value: normalized.value,
        sourceId: jsonNumber(jsonObject(rawEntry)?.id),
        sourceRepository:
          jsonString(jsonObject(rawEntry)?.repository) ??
          repositoryForCurrentDirectory(),
      };
      if (plan.sourceId !== undefined) {
        if (sources.has(plan.sourceId)) {
          return yield* commandError(
            "import",
            `Duplicate source id ${plan.sourceId}.`,
          );
        }
        sources.set(plan.sourceId, plan);
      }
      if (plan.value.statusRaw === "active") {
        const size = yield* measureEmbeddingFit(
          memoryVectorEmbeddingParts({
            id: "0",
            repository: repositoryForCurrentDirectory(),
            content: plan.value.content,
            tags: plan.value.tags,
            context: plan.value.memoContext,
            memory_type: plan.value.memoryTypeRaw,
            status: plan.value.statusRaw,
            certainty: plan.value.certaintyNormalized,
          }),
        );
        yield* Effect.try({
          try: () => assertBgeBreakdown(size, `Import index ${index}`),
          catch: (cause) =>
            commandError(
              "import",
              cause instanceof Error
                ? cause.message
                : "Embedding validation failed.",
              cause,
            ),
        });
      }
      if (!plan.targetId && plan.value.statusRaw === "active") {
        const conflicts = yield* detectPotentialConflicts(database, {
          content: plan.value.content,
          tags: plan.value.tags,
          context: plan.value.memoContext,
        });
        if (conflicts.length) {
          results[index] = {
            index,
            status: "conflict",
            potential_conflicts: conflicts,
          };
        }
      }
      plans.push(plan);
    }
    return yield* Effect.try({
      try: () => orderImportPlans(plans, sources, results),
      catch: (cause) => commandError("import", String(cause), cause),
    });
  });
}

function orderImportPlans(
  plans: ImportPlan[],
  sources: Map<number, ImportPlan>,
  results: JsonObject[],
): ImportPlan[] {
  for (const plan of plans) {
    if (plan.value.supersededBy === null) {
      continue;
    }
    const replacement = sources.get(plan.value.supersededBy);
    if (
      !replacement ||
      replacement === plan ||
      replacement.sourceRepository !== plan.sourceRepository ||
      results[replacement.index]?.status === "conflict"
    ) {
      throw new Error(
        `Invalid, unresolved, cross-repository or self superseded_by at index ${plan.index}.`,
      );
    }
    plan.replacement = replacement;
  }
  // Insert replacements first: even a partial import never commits a dangling source link.
  const ordered: ImportPlan[] = [];
  const visiting = new Set<ImportPlan>();
  const visited = new Set<ImportPlan>();
  const visit = (plan: ImportPlan): void => {
    if (visited.has(plan)) {
      return;
    }
    if (visiting.has(plan)) {
      throw new Error("Cyclic superseded_by links in import.");
    }
    visiting.add(plan);
    if (plan.replacement) {
      visit(plan.replacement);
    }
    visiting.delete(plan);
    visited.add(plan);
    ordered.push(plan);
  };
  plans.forEach(visit);
  return ordered;
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
    const results: JsonObject[] = parsed.map((_, index) => ({
      index,
      status: "unprocessed",
    }));
    const database = requireDatabase(commandCtx);
    let error: string | undefined;
    const preflight = yield* preflightImport(database, parsed, results).pipe(
      Effect.match({
        onFailure: (cause) => ({
          error: cause.message,
          plans: Array<ImportPlan>(),
        }),
        onSuccess: (plans) => ({ error: undefined, plans }),
      }),
    );
    error = preflight.error;
    if (!error) {
      for (const plan of preflight.plans) {
        if (results[plan.index]?.status !== "unprocessed") {
          continue;
        }
        const outcome = yield* Effect.gen(function* () {
          const replacementId = plan.replacement?.targetId;
          if (
            plan.replacement &&
            (replacementId === undefined ||
              !(yield* getMemoryById(database, replacementId)))
          ) {
            return yield* commandError(
              "import",
              `Replacement disappeared before index ${plan.index}.`,
            );
          }
          const inserted = yield* runImportInsert(database, {
            ...plan.value,
            supersededBy: replacementId ?? null,
          });
          const id = jsonNumber(jsonObject(inserted)?.lastInsertRowid);
          results[plan.index] = {
            index: plan.index,
            status: "success",
            id: id ?? null,
          };
          plan.targetId = id;
          if (id === undefined) {
            return yield* commandError(
              "import",
              "Insert committed but returned no allocated id; stopping import.",
            );
          }
        }).pipe(
          Effect.match({
            onFailure: (cause) => cause.message,
            onSuccess: () => undefined,
          }),
        );
        if (outcome) {
          error = outcome;
          break;
        }
      }
    }
    yield* Effect.sync(() => {
      if (error || results.some((result) => result.status === "conflict")) {
        process.exitCode = 1;
      }
      if (commandCtx.outputMode.quiet && !error) {
        return;
      }
      if (hasMinimalOutput(commandCtx.outputMode)) {
        const payload: JsonObject = {
          imported: results.filter((result) => result.status === "success")
            .length,
          failed: results.filter((result) => result.status !== "success")
            .length,
          count: results.length,
          results,
        };
        if (error) {
          payload.error = error;
        }
        printJson(payload);
        return;
      }
      const payload: JsonObject = { results };
      if (error) {
        payload.error = error;
      }
      printCommandOutput(commandCtx, payload);
    });
  });
}

import { Database } from "bun:sqlite";
import { resolve, relative, sep } from "node:path";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { getFlagValue, hasFlag, printJson, usageError } from "./lib/cli";
import {
  CERTAINTY_LEVELS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  VERSION,
  type Certainty,
  type CommonFilters,
  type MemoryStatus,
  type MemoryType,
} from "./lib/constants";
import { allWithRetry, ensureDb, getWithRetry, runWithRetry } from "./lib/db";
import { upgrade } from "./lib/upgrade";

function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

function isCertainty(value: string): value is Certainty {
  return (CERTAINTY_LEVELS as readonly string[]).includes(value);
}

function isMemoryStatus(value: string): value is MemoryStatus {
  return (MEMORY_STATUSES as readonly string[]).includes(value);
}

function requireMemoryType(args: string[], flag = "--type"): MemoryType | undefined {
  const raw = getFlagValue(args, flag);
  if (raw === undefined) {
    return undefined;
  }
  if (!isMemoryType(raw)) {
    printJson({
      error: `Invalid memory type '${raw}'. Expected one of: ${MEMORY_TYPES.join(", ")}`,
    });
    process.exit(1);
  }
  return raw;
}

function requireCertainty(
  args: string[],
  flag = "--certainty",
): Certainty | undefined {
  const raw = getFlagValue(args, flag);
  if (raw === undefined) {
    return undefined;
  }
  if (!isCertainty(raw)) {
    printJson({
      error: `Invalid certainty '${raw}'. Expected one of: ${CERTAINTY_LEVELS.join(", ")}`,
    });
    process.exit(1);
  }
  return raw;
}

function requireStatus(args: string[], flag = "--status"): MemoryStatus | undefined {
  const raw = getFlagValue(args, flag);
  if (raw === undefined) {
    return undefined;
  }
  if (!isMemoryStatus(raw)) {
    printJson({
      error: `Invalid status '${raw}'. Expected one of: ${MEMORY_STATUSES.join(", ")}`,
    });
    process.exit(1);
  }
  return raw;
}

function parseIntegerFlag(
  args: string[],
  flag: string,
  options: { allowNullLiteral?: boolean } = {},
): number | null | undefined {
  const raw = getFlagValue(args, flag);
  if (raw === undefined) {
    return undefined;
  }
  if (options.allowNullLiteral && raw.toLowerCase() === "null") {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    printJson({ error: `Invalid integer for ${flag}: ${raw}` });
    process.exit(1);
  }
  return parsed;
}

function parseRefsFlag(args: string[]): string[] | undefined {
  const raw = getFlagValue(args, "--refs");
  if (raw === undefined) {
    return undefined;
  }
  return parseRefsValue(raw);
}

function parseRefsValue(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("Expected JSON string array");
    }
    return (parsed as string[]).slice();
  } catch {
    const fallback = raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (fallback.length === 0) {
      printJson({
        error:
          "Invalid --refs value. Provide a JSON array (e.g. '[\"https://...\"]') or comma-separated list.",
      });
      process.exit(1);
    }
    return fallback;
  }
}

function parseTags(tags: string): string[] {
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeSqliteRow(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object") {
    return {};
  }
  const next = { ...(row as Record<string, unknown>) };
  next.refs = parseStoredRefs(next.refs);
  if (next.update_count !== undefined) {
    next.update_count = Number(next.update_count ?? 0);
  }
  if (next.superseded_by !== undefined && next.superseded_by !== null) {
    next.superseded_by = Number(next.superseded_by);
  }
  if (next.expires_after_days !== undefined && next.expires_after_days !== null) {
    next.expires_after_days = Number(next.expires_after_days);
  }
  return next;
}

function parseStoredRefs(value: unknown): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed as string[];
    }
    return [];
  } catch {
    return [];
  }
}

function sqliteDateToMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function extractTerms(input: string): string[] {
  const stopwords = new Set([
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
    "src",
    "lib",
    "app",
    "test",
    "tests",
  ]);

  const tokens = (input.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 2 && !stopwords.has(token),
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

function buildFtsQueryFromTerms(terms: string[]): string | undefined {
  const usable = terms.filter((term) => term.length > 0).slice(0, 12);
  if (usable.length === 0) {
    return undefined;
  }
  return usable.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function certaintyWeight(certainty: unknown): number {
  if (certainty === "hard") {
    return 20;
  }
  if (certainty === "soft") {
    return 10;
  }
  return 2;
}

function recencyWeight(updatedAt: unknown): number {
  const ms = sqliteDateToMs(updatedAt);
  if (ms === null) {
    return 0;
  }
  const ageDays = Math.max(0, (Date.now() - ms) / (1000 * 60 * 60 * 24));
  const capped = Math.min(ageDays, 180);
  return Number((30 * (1 - capped / 180)).toFixed(3));
}

function tagExactnessWeight(tags: unknown, queryTokens: string[]): number {
  if (typeof tags !== "string" || queryTokens.length === 0) {
    return 0;
  }
  const tagList = parseTags(tags).map((tag) => tag.toLowerCase());
  const tokenSet = new Set(queryTokens.map((token) => token.toLowerCase()));
  if (tagList.some((tag) => tokenSet.has(tag))) {
    return 18;
  }
  if (tagList.some((tag) => queryTokens.some((token) => tag.includes(token)))) {
    return 8;
  }
  return 0;
}

function updateCountWeight(updateCount: unknown): number {
  const count = Number(updateCount ?? 0);
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  return Math.min(count, 10) * 2;
}

function ftsWeight(ftsRank: unknown): number {
  const rank = Number(ftsRank);
  if (!Number.isFinite(rank)) {
    return 0;
  }
  // bm25() is typically <= 0 in SQLite FTS5; smaller/more-negative is better.
  const transformed = Math.max(0, Math.min(30, -rank * 10));
  return Number(transformed.toFixed(3));
}

function scoreMemory(row: Record<string, unknown>, queryTokens: string[]): number {
  const score =
    recencyWeight(row.updated_at) +
    tagExactnessWeight(row.tags, queryTokens) +
    updateCountWeight(row.update_count) +
    certaintyWeight(row.certainty) +
    ftsWeight(row.fts_rank);
  return Number(score.toFixed(3));
}

function shapeRowsWithScore(
  rows: unknown[],
  queryTokens: string[],
): Record<string, unknown>[] {
  const normalized = rows.map((row) => normalizeSqliteRow(row));
  const withScore = normalized.map((row) => ({
    ...row,
    score: scoreMemory(row, queryTokens),
  }));
  withScore.sort((a, b) => Number(b.score) - Number(a.score));
  return withScore.map((row) => {
    const rest = { ...(row as Record<string, unknown>) };
    delete rest.fts_rank;
    return rest;
  });
}

function parseCommonFilters(args: string[]): CommonFilters {
  return {
    tag: getFlagValue(args, "--tags"),
    memoryType: requireMemoryType(args),
    certainty: requireCertainty(args),
    status: requireStatus(args),
    includeDeprecated: hasFlag(args, "--include-deprecated"),
  };
}

type OutputMode = {
  brief: boolean;
  jsonMin: boolean;
  noConflicts: boolean;
  quiet: boolean;
};

function parseOutputMode(args: string[]): OutputMode {
  return {
    brief: hasFlag(args, "--brief"),
    jsonMin: hasFlag(args, "--json-min"),
    noConflicts: hasFlag(args, "--no-conflicts"),
    quiet: hasFlag(args, "--quiet"),
  };
}

function hasMinimalOutput(mode: OutputMode): boolean {
  return mode.brief || mode.jsonMin || mode.quiet;
}

function compactMemoryView(
  row: Record<string, unknown>,
): Pick<Record<string, unknown>, "id" | "score" | "memory_type" | "certainty" | "tags"> {
  return {
    id: row.id,
    score: row.score,
    memory_type: row.memory_type,
    certainty: row.certainty,
    tags: row.tags,
  };
}

function queryEmptyResultPayload(
  term: string,
  filters: CommonFilters,
  queryTokens: string[],
) {
  return {
    results: [],
    search_term: term,
    derived_terms: queryTokens,
    filters: {
      tags: filters.tag ?? null,
      type: filters.memoryType ?? null,
      certainty: filters.certainty ?? null,
      include_deprecated: filters.includeDeprecated,
    },
    hints: [
      "Try broader keywords or synonyms.",
      "Use --include-deprecated to include superseded/archived memories.",
      "Narrow with --tags/--type/--certainty when you know the scope.",
    ],
  };
}

function applySqlFilters(
  clauses: string[],
  params: (string | number)[],
  filters: CommonFilters,
  options: { defaultActiveOnly?: boolean } = {},
) {
  if (filters.tag) {
    clauses.push("tags LIKE ?");
    params.push(`%${filters.tag}%`);
  }
  if (filters.memoryType) {
    clauses.push("memory_type = ?");
    params.push(filters.memoryType);
  }
  if (filters.certainty) {
    clauses.push("certainty = ?");
    params.push(filters.certainty);
  }
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  } else if (options.defaultActiveOnly ?? true) {
    if (!filters.includeDeprecated) {
      clauses.push("status = 'active'");
    }
  }
}

function getMemoryById(
  database: Database,
  id: number,
): Record<string, unknown> | null {
  const row = getWithRetry(database, "SELECT * FROM memories WHERE id = ?", [id]);
  if (!row) {
    return null;
  }
  return normalizeSqliteRow(row);
}

function detectPotentialConflicts(
  database: Database,
  payload: { content: string; tags?: string; context?: string },
  options: { excludeId?: number; limit?: number } = {},
): Record<string, unknown>[] {
  const terms = extractTerms(
    [payload.content, payload.tags ?? "", payload.context ?? ""].join(" "),
  );
  const ftsQuery = buildFtsQueryFromTerms(terms);
  if (!ftsQuery) {
    return [];
  }

  const clauses = ["memories_fts MATCH ?", "m.status = 'active'"];
  const params: (string | number)[] = [ftsQuery];
  if (options.excludeId !== undefined) {
    clauses.push("m.id != ?");
    params.push(options.excludeId);
  }

  const rows = allWithRetry(
    database,
    `SELECT m.*, bm25(memories_fts) AS fts_rank
     FROM memories m
     JOIN memories_fts ON m.id = memories_fts.rowid
     WHERE ${clauses.join(" AND ")}
     ORDER BY bm25(memories_fts)
     LIMIT ${Number(options.limit ?? 5)}`,
    params,
  );

  return shapeRowsWithScore(rows as unknown[], terms);
}

function findExactDuplicate(
  database: Database,
  payload: { content: string; tags?: string; context?: string },
): Record<string, unknown> | null {
  const row = getWithRetry(
    database,
    `SELECT * FROM memories
     WHERE status = 'active'
       AND content = ?
       AND tags = ?
       AND context = ?
     LIMIT 1`,
    [payload.content, payload.tags ?? "", payload.context ?? ""],
  );
  return row ? normalizeSqliteRow(row) : null;
}

function collectDirectories(rootPath: string): string[] {
  const directories: string[] = [];
  const ignoreNames = new Set([
    ".git",
    ".agents",
    "node_modules",
    "dist",
    ".next",
    ".turbo",
    ".idea",
    ".vscode",
  ]);

  function walk(current: string) {
    let entries:
      | {
          name: string;
          isDirectory(): boolean;
        }[]
      | undefined;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (ignoreNames.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const child = resolve(current, entry.name);
      const rel = relative(rootPath, child).split(sep).join("/");
      directories.push(`${rel}/`);
      walk(child);
    }
  }

  if (existsSync(rootPath) && statSync(rootPath).isDirectory()) {
    walk(rootPath);
  }
  directories.sort();
  return directories;
}

function extractPathTermsFromFiles(paths: string[]): string[] {
  const terms: string[] = [];
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    const segments = normalized.split("/").filter(Boolean);
    for (const segment of segments) {
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

function parseFileList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseFileListJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("Expected JSON string array");
    }
    return (parsed as string[]).map((item) => item.trim()).filter(Boolean);
  } catch {
    usageError(
      'Invalid --files-json value. Provide a JSON array of paths, e.g. --files-json \'["src/a.ts","src/b.ts"]\'.',
    );
  }
}

function parseSuggestFiles(args: string[]): string[] {
  const filesRaw = getFlagValue(args, "--files");
  const filesJsonRaw = getFlagValue(args, "--files-json");
  if (!filesRaw && !filesJsonRaw) {
    usageError(
      'Usage: suggest --files "src/auth/jwt.ts,src/middleware/session.ts" OR --files-json \'["src/auth/jwt.ts","src/middleware/session.ts"]\'',
    );
  }
  if (filesRaw && filesJsonRaw) {
    usageError("Use either --files or --files-json, not both.");
  }
  return filesJsonRaw ? parseFileListJson(filesJsonRaw) : parseFileList(filesRaw ?? "");
}

function parseSqliteErrorDetails(err: unknown): {
  kind: "fts_parse" | "sqlite" | "unknown";
  message: string;
  hint?: string;
} {
  if (!(err instanceof Error)) {
    return {
      kind: "unknown",
      message: "Unexpected failure while running command.",
    };
  }
  const lower = err.message.toLowerCase();
  if (
    lower.includes("no such column") ||
    lower.includes("no such table") ||
    lower.includes("fts5: syntax error") ||
    lower.includes("malformed match expression")
  ) {
    return {
      kind: "fts_parse",
      message: "Search query could not be parsed by SQLite FTS.",
      hint: "Try simpler terms without punctuation, or wrap file paths in --files-json for shell-safe input.",
    };
  }
  if (lower.includes("sqlite")) {
    return {
      kind: "sqlite",
      message: "SQLite command failed.",
      hint: "Retry once; if this persists, run `machine-memory migrate` and verify DB permissions/path.",
    };
  }
  return {
    kind: "unknown",
    message: err.message,
  };
}

function parseSinceDate(args: string[]): string | undefined {
  const value = getFlagValue(args, "--since");
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    printJson({ error: `Invalid --since date: ${value}` });
    process.exit(1);
  }
  return value;
}

function sqliteDateForComparison(isoLike: string): string {
  const ms = Date.parse(isoLike);
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function assertFileExists(path: string): string {
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) {
    printJson({ error: `File not found: ${path}` });
    process.exit(1);
  }
  return resolved;
}

const [command, ...args] = process.argv.slice(2);

if (!command || command === "help" || command === "--help" || command === "-h") {
  printJson({
    name: "machine-memory",
    version: VERSION,
    description:
      "Persistent project-scoped memory for LLM agents. Stores facts, decisions, conventions, and gotchas in a local SQLite database so future agent sessions can recall them.",
    database: ".agents/memory.db (relative to cwd)",
    commands: {
      help: "Show this help message",
      add: {
        usage:
          "add <content> [--tags <tags>] [--context <context>] [--type <memory_type>] [--certainty <certainty>] [--source-agent <name>] [--refs <json_or_csv>] [--expires-after-days <n>] [--no-conflicts] [--brief|--json-min|--quiet]",
      },
      query: {
        usage:
          "query <search_term> [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--include-deprecated] [--brief|--json-min|--quiet]",
      },
      list: {
        usage:
          "list [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--status <status>] [--include-deprecated]",
      },
      get: { usage: "get <id>" },
      update: {
        usage:
          "update <id> <content> [--tags <tags>] [--context <context>] [--type <memory_type>] [--certainty <certainty>] [--updated-by <name>] [--refs <json_or_csv>] [--expires-after-days <n|null>]",
      },
      deprecate: {
        usage: "deprecate <id> [--superseded-by <id>] [--updated-by <name>]",
      },
      delete: { usage: "delete <id>" },
      suggest: {
        usage:
          'suggest (--files "src/a.ts,src/b.ts" | --files-json \'["src/a.ts","src/b.ts"]\') [--brief|--json-min|--quiet]',
      },
      migrate: { usage: "migrate" },
      coverage: { usage: "coverage [--root <path>]" },
      gc: { usage: "gc --dry-run" },
      stats: { usage: "stats" },
      import: { usage: "import <memories.json>" },
      export: {
        usage:
          "export [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--since <ISO date>]",
      },
      version: { usage: "version" },
      upgrade: { usage: "upgrade" },
    },
    enums: {
      memory_type: MEMORY_TYPES,
      certainty: CERTAINTY_LEVELS,
      status: MEMORY_STATUSES,
    },
    what_to_store: [
      "Architectural decisions (e.g. 'we chose Drizzle over Prisma because...')",
      "Project conventions (e.g. 'all API routes return { data, error } shape')",
      "Non-obvious gotchas (e.g. 'the users table uses UUIDs, not auto-increment')",
      "Environment/tooling notes (e.g. 'run machine-memory migrate after pulling main')",
      "User preferences (e.g. 'user prefers explicit error handling over try/catch')",
    ],
  });
  process.exit(!command ? 1 : 0);
}

if (command === "version") {
  printJson({ version: VERSION });
  process.exit(0);
}
if (command === "upgrade") {
  await upgrade();
  process.exit(0);
}

const dbCommands = new Set([
  "add",
  "query",
  "list",
  "get",
  "update",
  "deprecate",
  "delete",
  "suggest",
  "coverage",
  "gc",
  "stats",
  "import",
  "export",
  "migrate",
]);
const writeCommands = new Set(["add", "update", "deprecate", "delete", "import", "migrate"]);
const outputMode = parseOutputMode(args);

let memoryDb: Database | null = null;
if (dbCommands.has(command)) {
  try {
    memoryDb = ensureDb(writeCommands.has(command) ? "write" : "read");
  } catch (err) {
    printJson({
      error:
        err instanceof Error
          ? err.message
          : "Unable to open machine-memory database.",
    });
    process.exit(1);
  }
}

function requireDb(): Database {
  if (!memoryDb) {
    throw new Error("Database is not initialized for this command.");
  }
  return memoryDb;
}

try {
  switch (command) {
  case "add": {
    const database = requireDb();
    const content = args[0];
    if (!content) {
      usageError(
        "Usage: add <content> [--tags <tags>] [--context <context>] [--type <memory_type>] [--certainty <certainty>] [--source-agent <name>] [--refs <json_or_csv>] [--expires-after-days <n>] [--no-conflicts] [--brief|--json-min|--quiet]",
      );
    }

    const tags = getFlagValue(args, "--tags") ?? "";
    const memo = getFlagValue(args, "--context") ?? "";
    const memoryType = requireMemoryType(args) ?? "convention";
    const certainty = requireCertainty(args) ?? "soft";
    const sourceAgent = getFlagValue(args, "--source-agent") ?? "";
    const updatedBy = getFlagValue(args, "--updated-by") ?? sourceAgent;
    const refs = parseRefsFlag(args) ?? [];
    const expiresAfterDays = parseIntegerFlag(args, "--expires-after-days");
    const includeConflicts = !(outputMode.noConflicts || hasMinimalOutput(outputMode));

    const potentialConflicts = includeConflicts
      ? detectPotentialConflicts(database, {
          content,
          tags,
          context: memo,
        })
      : [];

    const result = runWithRetry(
      database,
      `INSERT INTO memories (
         content, tags, context, memory_type, certainty, status, superseded_by,
         source_agent, last_updated_by, update_count, refs, expires_after_days
       ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, 0, ?, ?)`,
      [
        content,
        tags,
        memo,
        memoryType,
        certainty,
        sourceAgent,
        updatedBy,
        JSON.stringify(refs),
        expiresAfterDays ?? null,
      ],
    );

    const created = getMemoryById(database, Number(result.lastInsertRowid));
    if (outputMode.jsonMin || outputMode.quiet) {
      printJson({ id: created?.id ?? result.lastInsertRowid });
      break;
    }
    if (outputMode.brief) {
      printJson({
        id: created?.id ?? result.lastInsertRowid,
        status: "created",
        conflict_count: potentialConflicts.length,
      });
      break;
    }

    const payload: Record<string, unknown> = {
      ...(created ?? {
        id: result.lastInsertRowid,
        content,
        tags,
        context: memo,
      }),
    };
    if (includeConflicts) {
      payload.potential_conflicts = potentialConflicts;
    }
    printJson(payload);
    break;
  }

  case "query": {
    const database = requireDb();
    const term = args[0];
    if (!term) {
      usageError("Usage: query <search_term>");
    }

    const filters = parseCommonFilters(args);
    const queryTokens = extractTerms([term, filters.tag ?? ""].join(" "));
    const ftsQuery = buildFtsQueryFromTerms(queryTokens);
    if (!ftsQuery) {
      printJson(queryEmptyResultPayload(term, filters, queryTokens));
      break;
    }

    const clauses = ["memories_fts MATCH ?"];
    const params: (string | number)[] = [ftsQuery];
    applySqlFilters(clauses, params, filters, { defaultActiveOnly: true });

    const rows = allWithRetry(
      database,
      `SELECT m.*, bm25(memories_fts) AS fts_rank
       FROM memories m
       JOIN memories_fts ON m.id = memories_fts.rowid
       WHERE ${clauses.join(" AND ")}
      ORDER BY bm25(memories_fts)`,
      params,
    );

    const results = shapeRowsWithScore(rows as unknown[], queryTokens);
    if (results.length === 0) {
      printJson(queryEmptyResultPayload(term, filters, queryTokens));
      break;
    }
    if (outputMode.jsonMin || outputMode.quiet) {
      printJson({ count: results.length, ids: results.map((entry) => entry.id) });
      break;
    }
    if (outputMode.brief) {
      printJson({
        count: results.length,
        top: results.slice(0, 5).map((entry) => compactMemoryView(entry)),
      });
      break;
    }
    printJson(results);
    break;
  }

  case "get": {
    const database = requireDb();
    const id = args[0];
    if (!id) {
      usageError("Usage: get <id>");
    }
    const row = getMemoryById(database, Number(id));
    printJson(row ?? { error: "Not found" });
    break;
  }

  case "update": {
    const database = requireDb();
    const id = args[0];
    const content = args[1];
    if (!id || !content) {
      usageError(
        "Usage: update <id> <content> [--tags <tags>] [--context <context>] [--type <memory_type>] [--certainty <certainty>] [--updated-by <name>] [--refs <json_or_csv>] [--expires-after-days <n|null>]",
      );
    }

    const tags = getFlagValue(args, "--tags");
    const memo = getFlagValue(args, "--context");
    const memoryType = requireMemoryType(args);
    const certainty = requireCertainty(args);
    const updatedBy = getFlagValue(args, "--updated-by");
    const refs = parseRefsFlag(args);
    const expiresAfterDays = parseIntegerFlag(args, "--expires-after-days", {
      allowNullLiteral: true,
    });

    const sets = [
      "content = ?",
      "updated_at = datetime('now')",
      "update_count = COALESCE(update_count, 0) + 1",
    ];
    const params: (string | number | null)[] = [content];

    if (tags !== undefined) {
      sets.push("tags = ?");
      params.push(tags);
    }
    if (memo !== undefined) {
      sets.push("context = ?");
      params.push(memo);
    }
    if (memoryType !== undefined) {
      sets.push("memory_type = ?");
      params.push(memoryType);
    }
    if (certainty !== undefined) {
      sets.push("certainty = ?");
      params.push(certainty);
    }
    if (updatedBy !== undefined) {
      sets.push("last_updated_by = ?");
      params.push(updatedBy);
    }
    if (refs !== undefined) {
      sets.push("refs = ?");
      params.push(JSON.stringify(refs));
    }
    if (expiresAfterDays !== undefined) {
      sets.push("expires_after_days = ?");
      params.push(expiresAfterDays);
    }

    params.push(Number(id));
    runWithRetry(database, `UPDATE memories SET ${sets.join(", ")} WHERE id = ?`, params);
    const updated = getMemoryById(database, Number(id));
    printJson(updated ?? { error: "Not found" });
    break;
  }

  case "deprecate": {
    const database = requireDb();
    const id = args[0];
    if (!id) {
      usageError("Usage: deprecate <id> [--superseded-by <id>] [--updated-by <name>]");
    }
    const supersededBy = parseIntegerFlag(args, "--superseded-by");
    if (supersededBy !== undefined && supersededBy === Number(id)) {
      usageError("A memory cannot supersede itself.");
    }
    const updatedBy = getFlagValue(args, "--updated-by");

    const sets = [
      "status = ?",
      "superseded_by = ?",
      "updated_at = datetime('now')",
      "update_count = COALESCE(update_count, 0) + 1",
    ];
    const params: (string | number | null)[] = [
      supersededBy !== undefined ? "superseded_by" : "deprecated",
      supersededBy ?? null,
    ];
    if (updatedBy !== undefined) {
      sets.push("last_updated_by = ?");
      params.push(updatedBy);
    }
    params.push(Number(id));

    runWithRetry(database, `UPDATE memories SET ${sets.join(", ")} WHERE id = ?`, params);
    const row = getMemoryById(database, Number(id));
    printJson(row ?? { error: "Not found" });
    break;
  }

  case "delete": {
    const database = requireDb();
    const id = args[0];
    if (!id) {
      usageError("Usage: delete <id>");
    }
    runWithRetry(database, "DELETE FROM memories WHERE id = ?", [Number(id)]);
    printJson({ deleted: Number(id) });
    break;
  }

  case "list": {
    const database = requireDb();
    const filters = parseCommonFilters(args);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    applySqlFilters(clauses, params, filters, { defaultActiveOnly: true });

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = allWithRetry(
      database,
      `SELECT * FROM memories ${where} ORDER BY updated_at DESC, id DESC`,
      params,
    );
    printJson((rows as unknown[]).map((row) => normalizeSqliteRow(row)));
    break;
  }

  case "suggest": {
    const database = requireDb();
    const files = parseSuggestFiles(args);
    const derivedTerms = extractPathTermsFromFiles(files);
    const ftsQuery = buildFtsQueryFromTerms(derivedTerms);
    if (!ftsQuery) {
      printJson({ files, derived_terms: [], results: [] });
      break;
    }

    const filters = parseCommonFilters(args);
    const clauses = ["memories_fts MATCH ?"];
    const params: (string | number)[] = [ftsQuery];
    applySqlFilters(clauses, params, filters, { defaultActiveOnly: true });

    const rows = allWithRetry(
      database,
      `SELECT m.*, bm25(memories_fts) AS fts_rank
       FROM memories m
       JOIN memories_fts ON m.id = memories_fts.rowid
       WHERE ${clauses.join(" AND ")}
       ORDER BY bm25(memories_fts)
       LIMIT 20`,
      params,
    );
    const results = shapeRowsWithScore(rows as unknown[], derivedTerms);

    if (outputMode.jsonMin || outputMode.quiet) {
      printJson({ count: results.length, ids: results.map((entry) => entry.id) });
      break;
    }
    if (outputMode.brief) {
      printJson({
        files,
        derived_terms: derivedTerms,
        count: results.length,
        top: results.slice(0, 5).map((entry) => compactMemoryView(entry)),
      });
      break;
    }

    printJson({
      files,
      derived_terms: derivedTerms,
      results,
    });
    break;
  }

  case "coverage": {
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
    break;
  }

  case "gc": {
    const database = requireDb();
    const dryRun = hasFlag(args, "--dry-run");
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
    break;
  }

  case "stats": {
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

      const certainty = stringValue(memory.certainty, "soft");
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
    break;
  }

  case "import": {
    const database = requireDb();
    const path = args[0];
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

    const results: Record<string, unknown>[] = [];

    for (const [index, rawEntry] of parsed.entries()) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        results.push({ index, status: "skip", reason: "invalid_entry" });
        continue;
      }
      const entry = rawEntry as Record<string, unknown>;
      const content = typeof entry.content === "string" ? entry.content : "";
      if (!content) {
        results.push({ index, status: "skip", reason: "missing_content" });
        continue;
      }

      const tags = typeof entry.tags === "string" ? entry.tags : "";
      const memoContext = typeof entry.context === "string" ? entry.context : "";
      const memoryTypeRaw =
        typeof entry.memory_type === "string" ? entry.memory_type : "convention";
      const certaintyRaw =
        typeof entry.certainty === "string" ? entry.certainty : "soft";
      const statusRaw = typeof entry.status === "string" ? entry.status : "active";
      const supersededBy =
        typeof entry.superseded_by === "number" && Number.isInteger(entry.superseded_by)
          ? entry.superseded_by
          : null;
      const sourceAgent =
        typeof entry.source_agent === "string" ? entry.source_agent : "";
      const lastUpdatedBy =
        typeof entry.last_updated_by === "string"
          ? entry.last_updated_by
          : sourceAgent;
      const updateCount =
        typeof entry.update_count === "number" && Number.isInteger(entry.update_count)
          ? entry.update_count
          : 0;
      const refs = Array.isArray(entry.refs)
        ? (entry.refs.filter((item): item is string => typeof item === "string"))
        : typeof entry.refs === "string"
          ? parseStoredRefs(entry.refs)
          : [];
      const expiresAfterDays =
        typeof entry.expires_after_days === "number" &&
        Number.isInteger(entry.expires_after_days)
          ? entry.expires_after_days
          : null;
      const createdAt =
        typeof entry.created_at === "string" && !Number.isNaN(Date.parse(entry.created_at))
          ? sqliteDateForComparison(entry.created_at)
          : undefined;
      const updatedAt =
        typeof entry.updated_at === "string" && !Number.isNaN(Date.parse(entry.updated_at))
          ? sqliteDateForComparison(entry.updated_at)
          : undefined;

      if (!isMemoryType(memoryTypeRaw)) {
        results.push({
          index,
          status: "skip",
          reason: "invalid_memory_type",
          memory_type: memoryTypeRaw,
        });
        continue;
      }
      if (!isCertainty(certaintyRaw)) {
        results.push({
          index,
          status: "skip",
          reason: "invalid_certainty",
          certainty: certaintyRaw,
        });
        continue;
      }
      if (!isMemoryStatus(statusRaw)) {
        results.push({
          index,
          status: "skip",
          reason: "invalid_status",
          status_value: statusRaw,
        });
        continue;
      }

      const duplicate = findExactDuplicate(database, {
        content,
        tags,
        context: memoContext,
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
        statusRaw === "active"
          ? detectPotentialConflicts(database, {
              content,
              tags,
              context: memoContext,
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

      if (createdAt && updatedAt) {
        const insert = runWithRetry(
          database,
          `INSERT INTO memories (
             content, tags, context, memory_type, status, superseded_by, source_agent,
             last_updated_by, update_count, certainty, refs, expires_after_days,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            content,
            tags,
            memoContext,
            memoryTypeRaw,
            statusRaw,
            supersededBy,
            sourceAgent,
            lastUpdatedBy,
            updateCount,
            certaintyRaw,
            JSON.stringify(refs),
            expiresAfterDays,
            createdAt,
            updatedAt,
          ],
        );
        results.push({ index, status: "success", id: insert.lastInsertRowid });
        continue;
      }

      const insert = runWithRetry(
        database,
        `INSERT INTO memories (
           content, tags, context, memory_type, status, superseded_by, source_agent,
           last_updated_by, update_count, certainty, refs, expires_after_days
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          content,
          tags,
          memoContext,
          memoryTypeRaw,
          statusRaw,
          supersededBy,
          sourceAgent,
          lastUpdatedBy,
          updateCount,
          certaintyRaw,
          JSON.stringify(refs),
          expiresAfterDays,
        ],
      );
      results.push({ index, status: "success", id: insert.lastInsertRowid });
    }

    printJson({ results });
    break;
  }

  case "export": {
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
    break;
  }

  case "migrate": {
    const database = requireDb();
    printJson({ status: "ok", migrated: true });
    database.close();
    memoryDb = null;
    break;
  }

    default:
      printJson({
        error: `Unknown command: ${command}. Run 'machine-memory help' for usage.`,
      });
      process.exit(1);
  }
} catch (err) {
  const details = parseSqliteErrorDetails(err);
  const payload: Record<string, unknown> = {
    error: details.message,
    command,
  };
  if (details.hint) {
    payload.hint = details.hint;
  }
  if (err instanceof Error) {
    payload.details = err.message;
  }
  printJson(payload);
  process.exit(1);
} finally {
  if (memoryDb) {
    memoryDb.close();
  }
}

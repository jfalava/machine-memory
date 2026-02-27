import { Database, type SQLQueryBindings } from "bun:sqlite";
import { dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { DB_PATH } from "./constants";

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = Number(process.env["MACHINE_MEMORY_BUSY_TIMEOUT_MS"] ?? 5000);
const BUSY_RETRIES = Number(process.env["MACHINE_MEMORY_BUSY_RETRIES"] ?? 6);
const BUSY_BACKOFF_MS = Number(process.env["MACHINE_MEMORY_BUSY_BACKOFF_MS"] ?? 25);

export type DbAccessMode = "read" | "write";

export function ensureDb(mode: DbAccessMode = "write"): Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const instance = new Database(DB_PATH);
  runWithRetry(instance, `PRAGMA busy_timeout = ${Math.max(0, BUSY_TIMEOUT_MS)}`);

  if (mode === "write") {
    migrateSchema(instance);
  } else {
    ensureSchemaReadable(instance);
    runWithRetry(instance, "PRAGMA query_only = ON");
  }

  return instance;
}

export function runWithRetry(
  database: Database,
  sql: string,
  params: SQLQueryBindings[] = [],
) {
  return withBusyRetry(() => database.run(sql, params));
}

export function getWithRetry(
  database: Database,
  sql: string,
  params: SQLQueryBindings[] = [],
) {
  return withBusyRetry(() => database.query(sql).get(...params));
}

export function allWithRetry(
  database: Database,
  sql: string,
  params: SQLQueryBindings[] = [],
) {
  return withBusyRetry(() => database.query(sql).all(...params));
}

function withBusyRetry<T>(operation: () => T): T {
  let attempts = 0;
  for (;;) {
    try {
      return operation();
    } catch (err) {
      if (!isBusyError(err) || attempts >= BUSY_RETRIES) {
        throw err;
      }
      attempts += 1;
      const backoffMs = BUSY_BACKOFF_MS * 2 ** (attempts - 1);
      Bun.sleepSync(Math.min(1000, Math.max(1, backoffMs)));
    }
  }
}

function isBusyError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const candidate = err as { code?: unknown; message?: unknown };
  if (candidate.code === "SQLITE_BUSY" || candidate.code === "SQLITE_LOCKED") {
    return true;
  }
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return message.toLowerCase().includes("database is locked");
}

function getUserVersion(database: Database): number {
  const row = getWithRetry(database, "PRAGMA user_version") as
    | { user_version?: unknown }
    | undefined;
  const parsed = Number(row?.user_version ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tableExists(database: Database, tableName: string): boolean {
  const row = getWithRetry(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName],
  );
  return Boolean(row);
}

function listMemoryColumns(database: Database): Set<string> {
  const rows = allWithRetry(database, "PRAGMA table_info(memories)") as {
    name?: unknown;
  }[];
  return new Set(
    rows
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter((columnName) => columnName.length > 0),
  );
}

function migrateSchema(database: Database) {
  const currentVersion = getUserVersion(database);
  if (currentVersion >= SCHEMA_VERSION && isSchemaReady(database)) {
    return;
  }

  runWithRetry(database, "BEGIN IMMEDIATE");
  try {
    runWithRetry(database, "PRAGMA journal_mode=WAL");
    runWithRetry(
      database,
      `
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '',
        context TEXT DEFAULT '',
        memory_type TEXT NOT NULL DEFAULT 'convention',
        status TEXT NOT NULL DEFAULT 'active',
        superseded_by INTEGER,
        source_agent TEXT DEFAULT '',
        last_updated_by TEXT DEFAULT '',
        update_count INTEGER NOT NULL DEFAULT 0,
        certainty TEXT NOT NULL DEFAULT 'soft',
        refs TEXT NOT NULL DEFAULT '[]',
        expires_after_days INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `,
    );

    ensureMemoryTableColumns(database);

    const needsFtsRebuild = !tableExists(database, "memories_fts");
    runWithRetry(
      database,
      `
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(content, tags, context, content='memories', content_rowid='id')
    `,
    );
    runWithRetry(
      database,
      `
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags, context)
        VALUES (new.id, new.content, new.tags, new.context);
      END
    `,
    );
    runWithRetry(
      database,
      `
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags, context)
        VALUES ('delete', old.id, old.content, old.tags, old.context);
      END
    `,
    );
    runWithRetry(
      database,
      `
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags, context)
        VALUES ('delete', old.id, old.content, old.tags, old.context);
        INSERT INTO memories_fts(rowid, content, tags, context)
        VALUES (new.id, new.content, new.tags, new.context);
      END
    `,
    );
    if (needsFtsRebuild) {
      runWithRetry(database, "INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
    }
    runWithRetry(database, `PRAGMA user_version = ${SCHEMA_VERSION}`);
    runWithRetry(database, "COMMIT");
  } catch (err) {
    try {
      runWithRetry(database, "ROLLBACK");
    } catch {}
    throw err;
  }
}

function ensureSchemaReadable(database: Database) {
  if (!tableExists(database, "memories")) {
    migrateSchema(database);
    return;
  }
  if (!isSchemaReady(database)) {
    throw new Error(
      "Database schema is outdated. Run 'machine-memory migrate' using a write-capable command.",
    );
  }
}

function isSchemaReady(database: Database): boolean {
  if (!tableExists(database, "memories_fts")) {
    return false;
  }
  const columns = listMemoryColumns(database);
  const required = [
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
  return required.every((columnName) => columns.has(columnName));
}

function ensureMemoryTableColumns(database: Database) {
  const columns = listMemoryColumns(database);

  const migrations: { name: string; sql: string }[] = [
    {
      name: "memory_type",
      sql: "ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'convention'",
    },
    {
      name: "status",
      sql: "ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    },
    {
      name: "superseded_by",
      sql: "ALTER TABLE memories ADD COLUMN superseded_by INTEGER",
    },
    {
      name: "source_agent",
      sql: "ALTER TABLE memories ADD COLUMN source_agent TEXT DEFAULT ''",
    },
    {
      name: "last_updated_by",
      sql: "ALTER TABLE memories ADD COLUMN last_updated_by TEXT DEFAULT ''",
    },
    {
      name: "update_count",
      sql: "ALTER TABLE memories ADD COLUMN update_count INTEGER NOT NULL DEFAULT 0",
    },
    {
      name: "certainty",
      sql: "ALTER TABLE memories ADD COLUMN certainty TEXT NOT NULL DEFAULT 'soft'",
    },
    {
      name: "refs",
      sql: "ALTER TABLE memories ADD COLUMN refs TEXT NOT NULL DEFAULT '[]'",
    },
    {
      name: "expires_after_days",
      sql: "ALTER TABLE memories ADD COLUMN expires_after_days INTEGER",
    },
  ];

  for (const migration of migrations) {
    if (!columns.has(migration.name)) {
      runWithRetry(database, migration.sql);
    }
  }
}

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { DB_PATH } from "./constants";

export function ensureDb(): Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const instance = new Database(DB_PATH);
  instance.run("PRAGMA journal_mode=WAL");
  instance.run(`
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
  `);

  ensureMemoryTableColumns(instance);

  instance.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, tags, context, content='memories', content_rowid='id')
  `);
  instance.run(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags, context)
      VALUES (new.id, new.content, new.tags, new.context);
    END
  `);
  instance.run(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags, context)
      VALUES ('delete', old.id, old.content, old.tags, old.context);
    END
  `);
  instance.run(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags, context)
      VALUES ('delete', old.id, old.content, old.tags, old.context);
      INSERT INTO memories_fts(rowid, content, tags, context)
      VALUES (new.id, new.content, new.tags, new.context);
    END
  `);

  // Ensure the FTS index is present for existing databases created before triggers/FTS.
  instance.run(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`);

  return instance;
}

function ensureMemoryTableColumns(database: Database) {
  const rows = database
    .query("PRAGMA table_info(memories)")
    .all() as { name?: unknown }[];
  const columns = new Set(
    rows
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter((columnName) => columnName.length > 0),
  );

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
      database.run(migration.sql);
    }
  }

  database.run(
    "UPDATE memories SET memory_type = 'convention' WHERE memory_type IS NULL OR memory_type = ''",
  );
  database.run(
    "UPDATE memories SET status = 'active' WHERE status IS NULL OR status = ''",
  );
  database.run(
    "UPDATE memories SET certainty = 'soft' WHERE certainty IS NULL OR certainty = ''",
  );
  database.run(
    "UPDATE memories SET refs = '[]' WHERE refs IS NULL OR trim(refs) = ''",
  );
  database.run(
    "UPDATE memories SET source_agent = '' WHERE source_agent IS NULL",
  );
  database.run(
    "UPDATE memories SET last_updated_by = COALESCE(last_updated_by, source_agent, '') WHERE last_updated_by IS NULL",
  );
  database.run("UPDATE memories SET update_count = 0 WHERE update_count IS NULL");
}

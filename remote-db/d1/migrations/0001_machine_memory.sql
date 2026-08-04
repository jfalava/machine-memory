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
  certainty TEXT NOT NULL DEFAULT 'inferred',
  refs TEXT NOT NULL DEFAULT '[]',
  expires_after_days INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
USING fts5(content, tags, context, content='memories', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags, context)
  VALUES (new.id, new.content, new.tags, new.context);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, context)
  VALUES ('delete', old.id, old.content, old.tags, old.context);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, context)
  VALUES ('delete', old.id, old.content, old.tags, old.context);
  INSERT INTO memories_fts(rowid, content, tags, context)
  VALUES (new.id, new.content, new.tags, new.context);
END;

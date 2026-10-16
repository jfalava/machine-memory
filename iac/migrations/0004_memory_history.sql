-- Keep complete previous memory rows so in-place updates can be inspected and restored.
CREATE TABLE IF NOT EXISTS memory_history (
  revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL,
  repository TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'update',
  content TEXT NOT NULL,
  tags TEXT,
  context TEXT,
  memory_type TEXT NOT NULL,
  status TEXT NOT NULL,
  superseded_by INTEGER,
  source_agent TEXT,
  last_updated_by TEXT,
  update_count INTEGER,
  certainty TEXT NOT NULL,
  refs TEXT,
  expires_after_days INTEGER,
  created_at TEXT,
  updated_at TEXT,
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS memory_history_memory_idx
ON memory_history(repository, memory_id, revision_id DESC);

CREATE TRIGGER IF NOT EXISTS memory_history_after_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_history (
    memory_id, repository, operation, content, tags, context, memory_type,
    status, superseded_by, source_agent, last_updated_by, update_count,
    certainty, refs, expires_after_days, created_at, updated_at
  ) VALUES (
    OLD.id, OLD.repository, 'update', OLD.content, OLD.tags, OLD.context,
    OLD.memory_type, OLD.status, OLD.superseded_by, OLD.source_agent,
    OLD.last_updated_by, OLD.update_count, OLD.certainty, OLD.refs,
    OLD.expires_after_days, OLD.created_at, OLD.updated_at
  );
END;

-- Deletion remains permanent in v1; do not leave recoverable snapshots behind.
CREATE TRIGGER IF NOT EXISTS memory_history_after_delete AFTER DELETE ON memories BEGIN
  DELETE FROM memory_history
  WHERE repository = OLD.repository AND memory_id = OLD.id;
END;

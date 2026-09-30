-- Canonical writes and index intent commit together, including trusted SQL clients.
-- Retain generations and tombstones: removing an entry would allow ABA on retry.
CREATE TABLE memory_vector_sync (
  memory_id INTEGER PRIMARY KEY,
  repository TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  delivered_generation INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_delivered_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX memory_vector_sync_pending ON memory_vector_sync(next_attempt_at);

INSERT INTO memory_vector_sync(memory_id, repository)
SELECT id, repository FROM memories;

CREATE TRIGGER memory_vector_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memory_vector_sync(memory_id, repository) VALUES (NEW.id, NEW.repository)
  ON CONFLICT(memory_id) DO UPDATE SET repository = excluded.repository,
    generation = generation + 1, next_attempt_at = 0, attempts = 0, last_error = NULL;
END;
CREATE TRIGGER memory_vector_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_vector_sync(memory_id, repository) VALUES (NEW.id, NEW.repository)
  ON CONFLICT(memory_id) DO UPDATE SET repository = excluded.repository,
    generation = generation + 1, next_attempt_at = 0, attempts = 0, last_error = NULL;
END;
CREATE TRIGGER memory_vector_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memory_vector_sync(memory_id, repository) VALUES (OLD.id, OLD.repository)
  ON CONFLICT(memory_id) DO UPDATE SET generation = generation + 1,
    next_attempt_at = 0, attempts = 0, last_error = NULL;
END;

-- Identity is immutable; moving records would invalidate references and vectors.
CREATE TRIGGER memories_identity BEFORE UPDATE OF id, repository ON memories
WHEN NEW.id != OLD.id OR NEW.repository != OLD.repository BEGIN
  SELECT RAISE(ABORT, 'memory identity is immutable');
END;

CREATE TABLE memory_migration_sources (
  repository TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  PRIMARY KEY(repository, source, source_id)
);

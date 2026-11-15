-- queued_at dates each pending index write so index status can report how long
-- the oldest one has waited. Rows queued before this migration keep 0 (unknown).
ALTER TABLE memory_vector_sync ADD COLUMN queued_at INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER memory_vector_insert;
DROP TRIGGER memory_vector_update;
DROP TRIGGER memory_vector_delete;

CREATE TRIGGER memory_vector_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memory_vector_sync(memory_id, repository, queued_at)
  VALUES (NEW.id, NEW.repository, unixepoch() * 1000)
  ON CONFLICT(memory_id) DO UPDATE SET repository = excluded.repository,
    generation = generation + 1, next_attempt_at = 0, attempts = 0, last_error = NULL,
    queued_at = excluded.queued_at;
END;
CREATE TRIGGER memory_vector_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_vector_sync(memory_id, repository, queued_at)
  VALUES (NEW.id, NEW.repository, unixepoch() * 1000)
  ON CONFLICT(memory_id) DO UPDATE SET repository = excluded.repository,
    generation = generation + 1, next_attempt_at = 0, attempts = 0, last_error = NULL,
    queued_at = excluded.queued_at;
END;
CREATE TRIGGER memory_vector_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memory_vector_sync(memory_id, repository, queued_at)
  VALUES (OLD.id, OLD.repository, unixepoch() * 1000)
  ON CONFLICT(memory_id) DO UPDATE SET generation = generation + 1,
    next_attempt_at = 0, attempts = 0, last_error = NULL,
    queued_at = excluded.queued_at;
END;

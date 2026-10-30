-- Rerunnable: the local CLI applies this file on every schema migration.
-- Avoid CASE ... END inside triggers: D1's HTTP parser rejects those bodies.
CREATE TRIGGER IF NOT EXISTS memories_validate_evidence_insert BEFORE INSERT ON memories BEGIN
  SELECT RAISE(ABORT, 'evidence must be a JSON array of unique evidence kinds') WHERE json_valid(NEW.evidence) = 0;
  SELECT RAISE(ABORT, 'evidence must be a JSON array of unique evidence kinds') WHERE json_type(NEW.evidence) != 'array'
    OR EXISTS (SELECT 1 FROM json_each(NEW.evidence) WHERE type != 'text' OR value NOT IN ('user_requirement', 'observed_implementation', 'verified_mechanism', 'tested_behavior'))
    OR json_array_length(NEW.evidence) != (SELECT count(DISTINCT value) FROM json_each(NEW.evidence));
  SELECT RAISE(ABORT, 'validation_gaps must be a JSON array of at most 16 nonblank strings of at most 300 characters') WHERE json_valid(NEW.validation_gaps) = 0;
  SELECT RAISE(ABORT, 'validation_gaps must be a JSON array of at most 16 nonblank strings of at most 300 characters') WHERE json_type(NEW.validation_gaps) != 'array'
    OR json_array_length(NEW.validation_gaps) > 16
    OR EXISTS (SELECT 1 FROM json_each(NEW.validation_gaps) WHERE type != 'text' OR length(trim(value)) = 0 OR length(value) > 300);
END;

CREATE TRIGGER IF NOT EXISTS memories_validate_evidence_update BEFORE UPDATE ON memories BEGIN
  SELECT RAISE(ABORT, 'evidence must be a JSON array of unique evidence kinds') WHERE json_valid(NEW.evidence) = 0;
  SELECT RAISE(ABORT, 'evidence must be a JSON array of unique evidence kinds') WHERE json_type(NEW.evidence) != 'array'
    OR EXISTS (SELECT 1 FROM json_each(NEW.evidence) WHERE type != 'text' OR value NOT IN ('user_requirement', 'observed_implementation', 'verified_mechanism', 'tested_behavior'))
    OR json_array_length(NEW.evidence) != (SELECT count(DISTINCT value) FROM json_each(NEW.evidence));
  SELECT RAISE(ABORT, 'validation_gaps must be a JSON array of at most 16 nonblank strings of at most 300 characters') WHERE json_valid(NEW.validation_gaps) = 0;
  SELECT RAISE(ABORT, 'validation_gaps must be a JSON array of at most 16 nonblank strings of at most 300 characters') WHERE json_type(NEW.validation_gaps) != 'array'
    OR json_array_length(NEW.validation_gaps) > 16
    OR EXISTS (SELECT 1 FROM json_each(NEW.validation_gaps) WHERE type != 'text' OR length(trim(value)) = 0 OR length(value) > 300);
END;

-- Snapshots must carry evidence so restore brings it back with the content.
DROP TRIGGER IF EXISTS memory_history_after_update;
CREATE TRIGGER memory_history_after_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_history (
    memory_id, repository, operation, content, tags, context, memory_type,
    status, superseded_by, source_agent, last_updated_by, update_count,
    certainty, refs, expires_after_days, created_at, updated_at,
    evidence, validation_gaps
  ) VALUES (
    OLD.id, OLD.repository, 'update', OLD.content, OLD.tags, OLD.context,
    OLD.memory_type, OLD.status, OLD.superseded_by, OLD.source_agent,
    OLD.last_updated_by, OLD.update_count, OLD.certainty, OLD.refs,
    OLD.expires_after_days, OLD.created_at, OLD.updated_at,
    OLD.evidence, OLD.validation_gaps
  );
END;

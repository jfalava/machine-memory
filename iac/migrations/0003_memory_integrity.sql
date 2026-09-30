CREATE TRIGGER IF NOT EXISTS memories_validate_insert BEFORE INSERT ON memories BEGIN
  SELECT CASE WHEN NEW.memory_type NOT IN ('decision', 'convention', 'gotcha', 'preference', 'constraint', 'reference', 'status')
    OR NEW.status NOT IN ('active', 'deprecated', 'superseded_by')
    OR NEW.certainty NOT IN ('verified', 'inferred', 'speculative')
    OR typeof(NEW.update_count) != 'integer' OR NEW.update_count < 0
    THEN RAISE(ABORT, 'invalid memory metadata') END;
  SELECT CASE WHEN NEW.superseded_by IS NOT NULL AND
    (NEW.superseded_by = NEW.id OR NOT EXISTS (SELECT 1 FROM memories WHERE id = NEW.superseded_by AND repository = NEW.repository))
    THEN RAISE(ABORT, 'replacement must exist in the same repository and cannot be self') END;
  SELECT CASE WHEN json_valid(NEW.refs) = 0 THEN RAISE(ABORT, 'refs must be a JSON string array') END;
  SELECT CASE WHEN json_type(NEW.refs) != 'array' OR EXISTS (SELECT 1 FROM json_each(NEW.refs) WHERE type != 'text')
    THEN RAISE(ABORT, 'refs must be a JSON string array') END;
  SELECT CASE WHEN NEW.expires_after_days IS NOT NULL AND (NEW.memory_type != 'status' OR typeof(NEW.expires_after_days) != 'integer' OR NEW.expires_after_days <= 0)
    THEN RAISE(ABORT, 'expiry requires a status memory and positive days') END;
  SELECT CASE WHEN NEW.status = 'active' AND length(CAST(
    NEW.content || CASE WHEN coalesce(NEW.tags, '') != '' THEN char(10) || 'Tags: ' || NEW.tags ELSE '' END ||
    CASE WHEN coalesce(NEW.context, '') != '' THEN char(10) || 'Context: ' || NEW.context ELSE '' END ||
    char(10) || 'Memory type: ' || NEW.memory_type || char(10) || 'Status: ' || NEW.status ||
    char(10) || 'Certainty: ' || NEW.certainty AS BLOB)) + 2 > 512
    THEN RAISE(ABORT, 'memory exceeds the 512 byte embedding budget') END;
END;

CREATE TRIGGER IF NOT EXISTS memories_validate_update BEFORE UPDATE ON memories BEGIN
  SELECT CASE WHEN NEW.memory_type NOT IN ('decision', 'convention', 'gotcha', 'preference', 'constraint', 'reference', 'status')
    OR NEW.status NOT IN ('active', 'deprecated', 'superseded_by')
    OR NEW.certainty NOT IN ('verified', 'inferred', 'speculative')
    OR typeof(NEW.update_count) != 'integer' OR NEW.update_count < 0
    THEN RAISE(ABORT, 'invalid memory metadata') END;
  SELECT CASE WHEN NEW.superseded_by IS NOT NULL AND
    (NEW.superseded_by = NEW.id OR NOT EXISTS (SELECT 1 FROM memories WHERE id = NEW.superseded_by AND repository = NEW.repository))
    THEN RAISE(ABORT, 'replacement must exist in the same repository and cannot be self') END;
  SELECT CASE WHEN json_valid(NEW.refs) = 0 THEN RAISE(ABORT, 'refs must be a JSON string array') END;
  SELECT CASE WHEN json_type(NEW.refs) != 'array' OR EXISTS (SELECT 1 FROM json_each(NEW.refs) WHERE type != 'text')
    THEN RAISE(ABORT, 'refs must be a JSON string array') END;
  SELECT CASE WHEN NEW.expires_after_days IS NOT NULL AND (NEW.memory_type != 'status' OR typeof(NEW.expires_after_days) != 'integer' OR NEW.expires_after_days <= 0)
    THEN RAISE(ABORT, 'expiry requires a status memory and positive days') END;
  SELECT CASE WHEN NEW.status = 'active' AND length(CAST(
    NEW.content || CASE WHEN coalesce(NEW.tags, '') != '' THEN char(10) || 'Tags: ' || NEW.tags ELSE '' END ||
    CASE WHEN coalesce(NEW.context, '') != '' THEN char(10) || 'Context: ' || NEW.context ELSE '' END ||
    char(10) || 'Memory type: ' || NEW.memory_type || char(10) || 'Status: ' || NEW.status ||
    char(10) || 'Certainty: ' || NEW.certainty AS BLOB)) + 2 > 512
    THEN RAISE(ABORT, 'memory exceeds the 512 byte embedding budget') END;
END;

-- Removing a replacement must not leave references to a nonexistent memory.
CREATE TRIGGER IF NOT EXISTS memories_replacement_deleted AFTER DELETE ON memories BEGIN
  UPDATE memories SET superseded_by = NULL, status = 'deprecated',
    update_count = update_count + 1, updated_at = datetime('now')
    WHERE superseded_by = OLD.id;
END;

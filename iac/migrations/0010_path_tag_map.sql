-- The tags a repository gives to memories about files under a path prefix.
-- add --path and the paths field of the add route read it; tag-map and the
-- tag-map routes write it. It replaces the file .agents/path-tags.json, which
-- only a checkout could read. tags is a comma-separated list, as on memories.
CREATE TABLE IF NOT EXISTS path_tag_map (
  repository TEXT NOT NULL,
  path_prefix TEXT NOT NULL,
  tags TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repository, path_prefix)
);

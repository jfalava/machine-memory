import { Schema } from "effect";

import { normalizeTags } from "./doctor";
import type { JsonValue } from "./json";

/** Tags a repository gives to memories about files under a path prefix. */
export const PathTagMappingSchema = Schema.Struct({
  path_prefix: Schema.String,
  tags: Schema.Array(Schema.String),
});
export type PathTagMapping = typeof PathTagMappingSchema.Type;

/** One prefix of the tag map that matched a path, with the tags it contributes. */
export const PathTagMatchSchema = Schema.Struct({
  path: Schema.String,
  prefix: Schema.String,
  tags: Schema.Array(Schema.String),
});
export type PathTagMatch = typeof PathTagMatchSchema.Type;

export type PathTagSuggestion = {
  /** Tags of every matching prefix, longest prefix first, each once. */
  readonly tags: string[];
  readonly matches: PathTagMatch[];
  /** Paths that no prefix of the map matched. */
  readonly unmatched: string[];
};

/** A path as the map stores and compares it: forward slashes, no leading `./`. */
export function normalizeTagMapPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .trim()
    .replace(/^\.\/+/, "");
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  if (path === prefix) {
    return true;
  }
  if (prefix.endsWith("/")) {
    return path.startsWith(prefix);
  }
  return path.startsWith(prefix) || path.startsWith(`${prefix}/`);
}

/** Tags the map assigns to one path or to several comma-separated paths. */
export function suggestPathTags(
  mappings: readonly PathTagMapping[],
  paths: string,
): PathTagSuggestion {
  const normalizedPaths = paths
    .split(",")
    .map(normalizeTagMapPath)
    .filter(Boolean);
  const longestFirst = mappings.toSorted(
    (left, right) => right.path_prefix.length - left.path_prefix.length,
  );
  const matches = normalizedPaths.flatMap((path) =>
    longestFirst.flatMap((mapping) =>
      pathMatchesPrefix(path, mapping.path_prefix)
        ? [{ path, prefix: mapping.path_prefix, tags: [...mapping.tags] }]
        : [],
    ),
  );
  return {
    tags: normalizeTags(matches.flatMap((match) => match.tags).join(",")),
    matches,
    unmatched: normalizedPaths.filter(
      (path) => !matches.some((match) => match.path === path),
    ),
  };
}

/** Every mapping of one repository, in prefix order. */
export function pathTagMapSelect(repository: string) {
  return {
    sql: "SELECT path_prefix, tags FROM path_tag_map WHERE repository = ? ORDER BY path_prefix",
    params: [repository],
  };
}

/** Sets the tags of one prefix, replacing the tags it had. */
export function pathTagMapUpsert(mapping: {
  readonly repository: string;
  readonly path_prefix: string;
  readonly tags: readonly string[];
}) {
  return {
    sql: `INSERT INTO path_tag_map (repository, path_prefix, tags) VALUES (?, ?, ?)
      ON CONFLICT(repository, path_prefix)
      DO UPDATE SET tags = excluded.tags, updated_at = datetime('now')`,
    params: [mapping.repository, mapping.path_prefix, mapping.tags.join(",")],
  };
}

export function pathTagMapDelete(repository: string, pathPrefix: string) {
  return {
    sql: "DELETE FROM path_tag_map WHERE repository = ? AND path_prefix = ?",
    params: [repository, pathPrefix],
  };
}

const PathTagMapRowSchema = Schema.Struct({
  path_prefix: Schema.String,
  tags: Schema.String,
});

export function pathTagMappingsFromRows(
  rows: readonly JsonValue[],
): PathTagMapping[] {
  return rows.map((raw) => {
    const row = Schema.decodeUnknownSync(PathTagMapRowSchema)(raw);
    return { path_prefix: row.path_prefix, tags: normalizeTags(row.tags) };
  });
}

/** The most directories one coverage request compares. */
export const COVERAGE_DIRECTORIES_MAX = 2000;

export type CoverageReport = {
  /** Directories no segment of which is a tag of an active memory. */
  readonly uncovered_paths: string[];
  /** How many active memories carry each tag. */
  readonly tag_distribution: Record<string, number>;
};

/**
 * Compares directory names with the tags of active memories. `tagLists` are
 * the stored comma-separated tags, one entry per memory.
 */
export function coverageReport(
  directories: readonly string[],
  tagLists: readonly string[],
): CoverageReport {
  const distribution: Record<string, number> = {};
  const known = new Set<string>();
  for (const tags of tagLists) {
    for (const tag of tags.split(",").map((value) => value.trim())) {
      if (tag !== "") {
        distribution[tag] = (distribution[tag] ?? 0) + 1;
        known.add(tag.toLowerCase());
      }
    }
  }
  return {
    uncovered_paths: directories.filter((directory) => {
      const segments = directory
        .replace(/\/$/, "")
        .split("/")
        .map((segment) => segment.toLowerCase())
        .filter(Boolean);
      return (
        segments.length > 0 && !segments.some((segment) => known.has(segment))
      );
    }),
    tag_distribution: distribution,
  };
}

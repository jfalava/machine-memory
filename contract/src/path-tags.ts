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

/** The text and tags of every active memory of one repository, for coverage. */
export function coverageMemoriesSelect(repository: string) {
  return {
    sql: `SELECT content || ' ' || COALESCE(context, '') || ' ' || COALESCE(refs, '') AS text,
      COALESCE(tags, '') AS tags
      FROM memories WHERE repository = ? AND status = 'active'`,
    params: [repository],
  };
}

/** What coverage reads of one active memory. */
export type CoverageMemory = {
  /** Content, context and references, where a memory names paths. */
  readonly text: string;
  /** The stored comma-separated tags. */
  readonly tags: string;
};

export type CoverageReport = {
  /** Directories no active memory is about. */
  readonly uncovered_paths: string[];
  /** For each other directory, how many active memories are about something in it. */
  readonly covered_paths: Record<string, number>;
  /** How many active memories carry each tag. */
  readonly tag_distribution: Record<string, number>;
};

/** Where a path cannot continue: whitespace, quotes, brackets of prose and list separators. */
const PATH_TOKEN_BREAK = /[\s"'`(),;<>|=*]+/;

/**
 * Every directory a text names a path under: `cli/src/app.ts` names `cli` and
 * `cli/src`. Only a token with a slash is a path, so the word `cli` names
 * nothing. A token that starts with a slash or a scheme is a URL or an
 * absolute path, and names no directory of the repository.
 */
function namedDirectories(text: string): Set<string> {
  const named = new Set<string>();
  for (const raw of text.split(PATH_TOKEN_BREAK)) {
    const token = normalizeTagMapPath(raw).replace(/[.:!?]+$/, "");
    const segments = token.includes("/") ? token.split("/") : [];
    for (let end = 1; end <= segments.length; end += 1) {
      named.add(segments.slice(0, end).join("/"));
    }
  }
  return named;
}

function addHolder(index: Map<string, Set<number>>, key: string, id: number) {
  index.set(key, (index.get(key) ?? new Set<number>()).add(id));
}

/** Which memories name each directory, which carry each tag, and the tag counts. */
function indexCoverageMemories(memories: readonly CoverageMemory[]) {
  const distribution: Record<string, number> = {};
  const byDirectory = new Map<string, Set<number>>();
  const byTag = new Map<string, Set<number>>();
  memories.forEach((memory, id) => {
    for (const tag of memory.tags.split(",").map((value) => value.trim())) {
      if (tag !== "") {
        distribution[tag] = (distribution[tag] ?? 0) + 1;
        addHolder(byTag, tag.toLowerCase(), id);
      }
    }
    for (const directory of namedDirectories(memory.text)) {
      addHolder(byDirectory, directory, id);
    }
  });
  return { distribution, byDirectory, byTag };
}

/** Tags the map gives to the directory, or to a prefix inside it. */
function tagsForDirectory(
  mappings: readonly PathTagMapping[],
  directory: string,
): string[] {
  return mappings.flatMap((mapping) =>
    pathMatchesPrefix(directory, mapping.path_prefix) ||
    `${mapping.path_prefix.replace(/\/+$/, "")}/`.startsWith(directory)
      ? mapping.tags
      : [],
  );
}

/**
 * Sorts directories by whether an active memory is about something in them. A
 * memory is about a directory when its text names a path in it, or when it
 * carries a tag the tag map gives to the directory or to a prefix inside it.
 * A memory about `cli/src/app.ts` therefore covers `cli/` and `cli/src/`, and
 * not `cli/src/commands/`. Paths are compared as written, tags in lower case.
 */
export function coverageReport(
  directories: readonly string[],
  memories: readonly CoverageMemory[],
  mappings: readonly PathTagMapping[],
): CoverageReport {
  const { distribution, byDirectory, byTag } = indexCoverageMemories(memories);
  const uncovered: string[] = [];
  const covered: Record<string, number> = {};
  for (const directory of directories) {
    const path = normalizeTagMapPath(directory).replace(/\/+$/, "");
    const holders = new Set(byDirectory.get(path));
    for (const tag of tagsForDirectory(mappings, `${path}/`)) {
      for (const id of byTag.get(tag) ?? []) {
        holders.add(id);
      }
    }
    if (path !== "" && holders.size === 0) {
      uncovered.push(directory);
    } else if (path !== "") {
      covered[directory] = holders.size;
    }
  }
  return {
    uncovered_paths: uncovered,
    covered_paths: covered,
    tag_distribution: distribution,
  };
}

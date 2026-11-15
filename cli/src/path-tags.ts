import { resolve } from "node:path";

import {
  normalizeTagMapPath,
  normalizeTags,
  pathTagMapDelete,
  pathTagMappingsFromRows,
  pathTagMapSelect,
  pathTagMapUpsert,
  suggestPathTags,
  type PathTagMapping,
  type PathTagSuggestion,
} from "@machine-memory/contract";
import { Effect, Schema, type FileSystem } from "effect";

import type { MemoryDatabaseApi } from "./effect/database";
import { CommandError, type MemoryDatabaseError } from "./effect/errors";
import { toContractValue } from "./effect/remote-http";
import { jsonObject, jsonStringArray, parseJson } from "./json";
import { repositoryForCurrentDirectory } from "./repository";

/** The file that held the tag map before it moved into the database. */
export function legacyTagMapFilePath(cwd = process.cwd()): string {
  return resolve(cwd, ".agents", "path-tags.json");
}

/** The tag map of the current repository, in prefix order. */
export function loadPathTagMap(
  database: MemoryDatabaseApi,
): Effect.Effect<PathTagMapping[], MemoryDatabaseError> {
  const query = pathTagMapSelect(repositoryForCurrentDirectory());
  return database
    .all(query.sql, query.params)
    .pipe(
      Effect.map((rows) => pathTagMappingsFromRows(rows.map(toContractValue))),
    );
}

/** Sets the tags of one prefix, replacing the tags it had. */
export function setPathTags(
  database: MemoryDatabaseApi,
  mapping: PathTagMapping,
): Effect.Effect<void, MemoryDatabaseError> {
  const query = pathTagMapUpsert({
    repository: repositoryForCurrentDirectory(),
    ...mapping,
  });
  return database.run(query.sql, query.params).pipe(Effect.asVoid);
}

export function deletePathTags(
  database: MemoryDatabaseApi,
  pathPrefix: string,
): Effect.Effect<void, MemoryDatabaseError> {
  const query = pathTagMapDelete(repositoryForCurrentDirectory(), pathPrefix);
  return database.run(query.sql, query.params).pipe(Effect.asVoid);
}

/** Tags the map assigns to one path or to several comma-separated paths. */
export function suggestTagsForPath(
  database: MemoryDatabaseApi,
  paths: string,
): Effect.Effect<PathTagSuggestion, MemoryDatabaseError> {
  return loadPathTagMap(database).pipe(
    Effect.map((mappings) => suggestPathTags(mappings, paths)),
  );
}

/** The mappings of the legacy file; undefined when the checkout has none. */
export function readLegacyTagMap(
  fileSystem: FileSystem.FileSystem,
): Effect.Effect<PathTagMapping[] | undefined, CommandError> {
  const filePath = legacyTagMapFilePath();
  const unreadable = (cause: unknown) =>
    new CommandError({
      message: `Unable to read ${filePath}: ${String(cause)}`,
      command: "tag-map",
      cause,
    });
  return Effect.gen(function* () {
    if (!(yield* fileSystem.exists(filePath))) {
      return undefined;
    }
    const text = new TextDecoder().decode(yield* fileSystem.readFile(filePath));
    const parsed = yield* Effect.try({
      try: () => parseJson(text),
      catch: unreadable,
    });
    return Object.entries(jsonObject(parsed) ?? {}).flatMap(
      ([rawPrefix, value]) => {
        const mapping = {
          path_prefix: normalizeTagMapPath(rawPrefix),
          tags: normalizeTags((jsonStringArray(value) ?? []).join(",")),
        };
        return mapping.path_prefix !== "" && mapping.tags.length > 0
          ? [mapping]
          : [];
      },
    );
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(CommandError)(cause) ? cause : unreadable(cause),
    ),
  );
}

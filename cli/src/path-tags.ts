import { Effect, FileSystem } from "effect";
import { dirname, resolve } from "node:path";
import { CommandError } from "./effect/errors";

type PathTagMap = Record<string, string[]>;

function normalizePath(value: string): string {
  const normalized = value
    .replaceAll("\\", "/")
    .trim()
    .replace(/^\.\/+/, "");
  return normalized;
}

function normalizeTags(tags: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of tags) {
    const cleaned = rawTag.trim();
    if (!cleaned || seen.has(cleaned.toLowerCase())) {
      continue;
    }
    seen.add(cleaned.toLowerCase());
    unique.push(cleaned);
  }
  return unique;
}

export function pathTagMapFilePath(cwd = process.cwd()): string {
  return resolve(cwd, ".agents", "path-tags.json");
}

export function loadPathTagMap(
  fileSystem: FileSystem.FileSystem,
  cwd = process.cwd(),
): Effect.Effect<PathTagMap, CommandError> {
  const filePath = pathTagMapFilePath(cwd);
  return Effect.gen(function* () {
    if (!(yield* fileSystem.exists(filePath))) {
      return {};
    }
    const bytes = yield* fileSystem.readFile(filePath);
    const parsed = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      catch: (cause) =>
        new CommandError({
          message: `Failed to parse path tag map: ${String(cause)}`,
          command: "tag-map",
          cause,
        }),
    });
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const next: PathTagMap = {};
    for (const [rawPrefix, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const prefix = normalizePath(rawPrefix);
      if (!prefix || !Array.isArray(value)) {
        continue;
      }
      const tags = normalizeTags(
        value.filter((item): item is string => typeof item === "string"),
      );
      if (tags.length > 0) {
        next[prefix] = tags;
      }
    }
    return next;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof CommandError
        ? cause
        : new CommandError({
            message: "Unable to read path tag map.",
            command: "tag-map",
            cause,
          }),
    ),
  );
}

export function savePathTagMap(
  fileSystem: FileSystem.FileSystem,
  map: PathTagMap,
  cwd = process.cwd(),
): Effect.Effect<void, never> {
  const filePath = pathTagMapFilePath(cwd);
  return fileSystem
    .makeDirectory(dirname(filePath), { recursive: true })
    .pipe(
      Effect.andThen(
        fileSystem.writeFile(
          filePath,
          new TextEncoder().encode(JSON.stringify(map, null, 2)),
        ),
      ),
      Effect.orDie,
    );
}

export function upsertPathTagMapEntry(
  fileSystem: FileSystem.FileSystem,
  pathPrefix: string,
  tags: string[],
  cwd = process.cwd(),
): Effect.Effect<PathTagMap, CommandError> {
  const prefix = normalizePath(pathPrefix);
  if (!prefix) {
    return Effect.succeed({});
  }
  const normalized = normalizeTags(tags);
  return Effect.gen(function* () {
    const map = yield* loadPathTagMap(fileSystem, cwd);
    if (normalized.length > 0) {
      map[prefix] = normalized;
    }
    yield* savePathTagMap(fileSystem, map, cwd);
    return map;
  });
}

export function deletePathTagMapEntry(
  fileSystem: FileSystem.FileSystem,
  pathPrefix: string,
  cwd = process.cwd(),
): Effect.Effect<PathTagMap, CommandError> {
  const prefix = normalizePath(pathPrefix);
  return Effect.gen(function* () {
    const map = yield* loadPathTagMap(fileSystem, cwd);
    if (prefix in map) {
      delete map[prefix];
      yield* savePathTagMap(fileSystem, map, cwd);
    }
    return map;
  });
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

export function suggestTagsForPath(
  fileSystem: FileSystem.FileSystem,
  path: string,
  cwd = process.cwd(),
): Effect.Effect<string[], CommandError> {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) {
    return Effect.succeed([]);
  }
  return loadPathTagMap(fileSystem, cwd).pipe(
    Effect.map((map) => {
      const tags: string[] = [];
      const entries = Object.entries(map).sort(
        (left, right) => right[0].length - left[0].length,
      );
      for (const [prefix, mappedTags] of entries) {
        if (pathMatchesPrefix(normalizedPath, prefix)) {
          tags.push(...mappedTags);
        }
      }
      return normalizeTags(tags);
    }),
  );
}

import { normalizeTagMapPath, normalizeTags } from "@machine-memory/contract";
import { Effect } from "effect";

import { usageError, warnOnStderr } from "../../cli-utils";
import {
  deletePathTags,
  legacyTagMapFilePath,
  loadPathTagMap,
  readLegacyTagMap,
  setPathTags,
  suggestTagsForPath,
} from "../../path-tags";
import { repositoryForCurrentDirectory } from "../../repository";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";

type TagMapEffect = Effect.Effect<void, unknown, never>;

const USAGE =
  "tag-map <list|set|delete|suggest|import> [path_prefix] [tags_csv|path] (--local|--remote)";

/**
 * The map lived in a file before it moved into the database. A checkout that
 * still has the file and no mappings would otherwise lose its tags silently.
 */
function warnOfLegacyFile(context: CommandContext, mappingCount: number) {
  return mappingCount > 0
    ? Effect.void
    : context.fileSystem.exists(legacyTagMapFilePath()).pipe(
        Effect.map((exists) => {
          if (exists) {
            warnOnStderr(
              ".agents/path-tags.json is no longer read: the tag map is stored in the database. Load the file once with 'machine-memory tag-map import', then delete it.",
            );
          }
        }),
      );
}

function listTagMap(context: CommandContext): TagMapEffect {
  return Effect.gen(function* () {
    const mappings = yield* loadPathTagMap(requireDatabase(context));
    yield* warnOfLegacyFile(context, mappings.length);
    printCommandOutput(context, {
      repository: repositoryForCurrentDirectory(),
      count: mappings.length,
      mappings,
    });
  });
}

function setTagMap(
  context: CommandContext,
  pathPrefix: string | undefined,
  tagsRaw: string | undefined,
): TagMapEffect {
  return Effect.gen(function* () {
    const mapping = {
      path_prefix: normalizeTagMapPath(pathPrefix ?? ""),
      tags: normalizeTags(tagsRaw ?? ""),
    };
    if (mapping.path_prefix === "" || mapping.tags.length === 0) {
      usageError("Usage: tag-map set <path_prefix> <tag1,tag2,...>");
    }
    yield* setPathTags(requireDatabase(context), mapping);
    printCommandOutput(context, {
      status: "ok",
      repository: repositoryForCurrentDirectory(),
      ...mapping,
    });
  });
}

function deleteTagMap(
  context: CommandContext,
  rawPrefix: string | undefined,
): TagMapEffect {
  return Effect.gen(function* () {
    const pathPrefix = normalizeTagMapPath(rawPrefix ?? "");
    if (pathPrefix === "") {
      usageError("Usage: tag-map delete <path_prefix>");
    }
    const database = requireDatabase(context);
    const existed = (yield* loadPathTagMap(database)).some(
      (mapping) => mapping.path_prefix === pathPrefix,
    );
    if (existed) {
      yield* deletePathTags(database, pathPrefix);
    }
    printCommandOutput(context, {
      status: existed ? "deleted" : "not_found",
      repository: repositoryForCurrentDirectory(),
      path_prefix: pathPrefix,
    });
  });
}

function suggestTagMap(
  context: CommandContext,
  filePath: string | undefined,
): TagMapEffect {
  return Effect.gen(function* () {
    if (!filePath) {
      usageError("Usage: tag-map suggest <path|path,path,...>");
    }
    const database = requireDatabase(context);
    const suggestion = yield* suggestTagsForPath(database, filePath);
    if (suggestion.matches.length === 0) {
      yield* warnOfLegacyFile(
        context,
        (yield* loadPathTagMap(database)).length,
      );
    }
    printCommandOutput(context, {
      path: filePath,
      tags: suggestion.tags,
      matches: suggestion.matches,
      unmatched_paths: suggestion.unmatched,
    });
  });
}

/** Loads the mappings of the legacy file into the database, once. */
function importTagMap(context: CommandContext): TagMapEffect {
  return Effect.gen(function* () {
    const mappings = yield* readLegacyTagMap(context.fileSystem);
    if (mappings === undefined) {
      usageError(
        `Nothing to import: ${legacyTagMapFilePath()} does not exist.`,
      );
    }
    const database = requireDatabase(context);
    for (const mapping of mappings) {
      yield* setPathTags(database, mapping);
    }
    printCommandOutput(context, {
      status: "ok",
      repository: repositoryForCurrentDirectory(),
      imported: mappings.length,
      mappings,
    });
    warnOnStderr(
      `Imported ${mappings.length} mapping(s). ${legacyTagMapFilePath()} is no longer read; delete it.`,
    );
  });
}

export function handleTagMapCommand(context: CommandContext): TagMapEffect {
  const [action, first, second] = context.positionals;
  const handlers = new Map<string, () => TagMapEffect>([
    ["list", () => listTagMap(context)],
    ["set", () => setTagMap(context, first, second)],
    ["delete", () => deleteTagMap(context, first)],
    ["suggest", () => suggestTagMap(context, first)],
    ["import", () => importTagMap(context)],
  ]);
  return (
    handlers.get(action ?? "")?.() ??
    Effect.sync(() => usageError(`Usage: ${USAGE}`))
  );
}

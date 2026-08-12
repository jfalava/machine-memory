import { Effect } from "effect";
import { usageError } from "../../cli-utils";
import {
  deletePathTagMapEntry,
  loadPathTagMap,
  pathTagMapFilePath,
  suggestTagsForPath,
  upsertPathTagMapEntry,
} from "../../path-tags";
import { parseTags } from "../shared";
import type { CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";

type TagMapEffect = Effect.Effect<void, unknown, never>;

function listTagMap(context: CommandContext): TagMapEffect {
  return Effect.gen(function* () {
    const map = yield* loadPathTagMap(context.fileSystem);
    yield* Effect.sync(() =>
      printCommandOutput(context, {
        file: pathTagMapFilePath(),
        mappings: Object.entries(map).map(([path_prefix, tags]) => ({
          path_prefix,
          tags,
        })),
      }),
    );
  });
}

function setTagMap(
  context: CommandContext,
  pathPrefix: string | undefined,
  tagsRaw: string | undefined,
): TagMapEffect {
  return Effect.gen(function* () {
    if (!pathPrefix || !tagsRaw) {
      usageError("Usage: tag-map set <path_prefix> <tag1,tag2,...>");
    }
    const tags = parseTags(tagsRaw);
    if (tags.length === 0) {
      usageError("Usage: tag-map set <path_prefix> <tag1,tag2,...>");
    }
    yield* upsertPathTagMapEntry(context.fileSystem, pathPrefix, tags);
    yield* Effect.sync(() =>
      printCommandOutput(context, {
        status: "ok",
        path_prefix: pathPrefix,
        tags,
        file: pathTagMapFilePath(),
      }),
    );
  });
}

function deleteTagMap(
  context: CommandContext,
  pathPrefix: string | undefined,
): TagMapEffect {
  return Effect.gen(function* () {
    if (!pathPrefix) {
      usageError("Usage: tag-map delete <path_prefix>");
    }
    const current = yield* loadPathTagMap(context.fileSystem);
    const existed = Object.hasOwn(current, pathPrefix);
    yield* deletePathTagMapEntry(context.fileSystem, pathPrefix);
    yield* Effect.sync(() =>
      printCommandOutput(context, {
        status: existed ? "deleted" : "not_found",
        path_prefix: pathPrefix,
        file: pathTagMapFilePath(),
      }),
    );
  });
}

function suggestTagMap(
  context: CommandContext,
  filePath: string | undefined,
): TagMapEffect {
  return Effect.gen(function* () {
    if (!filePath) {
      usageError("Usage: tag-map suggest <path>");
    }
    const tags = yield* suggestTagsForPath(context.fileSystem, filePath);
    yield* Effect.sync(() =>
      printCommandOutput(context, { path: filePath, tags }),
    );
  });
}

export function handleTagMapCommand(context: CommandContext): TagMapEffect {
  const [action, first, second] = context.args;
  const handlers = new Map<string, () => TagMapEffect>([
    ["list", () => listTagMap(context)],
    ["set", () => setTagMap(context, first, second)],
    ["delete", () => deleteTagMap(context, first)],
    ["suggest", () => suggestTagMap(context, first)],
  ]);
  return (
    handlers.get(action ?? "")?.() ??
    Effect.sync(() =>
      usageError("Usage: tag-map <list|set|delete|suggest> [args]"),
    )
  );
}

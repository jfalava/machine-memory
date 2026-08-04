import { Effect } from "effect";
import { printJson, usageError } from "../../cli";
import {
  deletePathTagMapEntry,
  loadPathTagMap,
  pathTagMapFilePath,
  suggestTagsForPath,
  upsertPathTagMapEntry,
} from "../../path-tags";
import { parseTags } from "../shared";
import type { CommandContext } from "./context";

export function handleTagMapCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const [action, first, second] = commandCtx.args;
    if (action === "list") {
      const map = yield* loadPathTagMap(commandCtx.fileSystem);
      yield* Effect.sync(() =>
        printJson({
          file: pathTagMapFilePath(),
          mappings: Object.entries(map).map(([path_prefix, tags]) => ({
            path_prefix,
            tags,
          })),
        }),
      );
      return;
    }
    if (action === "set") {
      if (!first || !second) {
        usageError("Usage: tag-map set <path_prefix> <tag1,tag2,...>");
      }
      const tags = parseTags(second);
      if (tags.length === 0) {
        usageError("Usage: tag-map set <path_prefix> <tag1,tag2,...>");
      }
      yield* upsertPathTagMapEntry(commandCtx.fileSystem, first, tags);
      yield* Effect.sync(() =>
        printJson({
          status: "ok",
          path_prefix: first,
          tags,
          file: pathTagMapFilePath(),
        }),
      );
      return;
    }
    if (action === "delete") {
      if (!first) {
        usageError("Usage: tag-map delete <path_prefix>");
      }
      const current = yield* loadPathTagMap(commandCtx.fileSystem);
      const existed = Object.hasOwn(current, first);
      yield* deletePathTagMapEntry(commandCtx.fileSystem, first);
      yield* Effect.sync(() =>
        printJson({
          status: existed ? "deleted" : "not_found",
          path_prefix: first,
          file: pathTagMapFilePath(),
        }),
      );
      return;
    }
    if (action === "suggest") {
      if (!first) {
        usageError("Usage: tag-map suggest <path>");
      }
      const tags = yield* suggestTagsForPath(commandCtx.fileSystem, first);
      yield* Effect.sync(() => printJson({ path: first, tags }));
      return;
    }
    usageError("Usage: tag-map <list|set|delete|suggest> [args]");
  });
}

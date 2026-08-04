import { Effect } from "effect";
import { resolve } from "node:path";
import { getFlagValue, printJson } from "../../cli-utils";
import { repositoryForCurrentDirectory } from "../../repository";
import { collectDirectoriesEffect, parseTags, stringValue } from "../shared";
import { requireDatabase, type CommandContext } from "../runtime/context";

export function handleCoverageCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args } = commandCtx;
    const database = requireDatabase(commandCtx);
    const root = resolve(process.cwd(), getFlagValue(args, "--root") ?? ".");
    const directories = yield* collectDirectoriesEffect(
      root,
      commandCtx.fileSystem,
    );
    const rows = yield* database.all(
      "SELECT tags FROM memories WHERE repository = ? AND status = 'active'",
      [repositoryForCurrentDirectory()],
    );
    const tagDistribution: Record<string, number> = {};
    const tagSet = new Set<string>();
    for (const row of rows as { tags?: unknown }[]) {
      for (const tag of parseTags(stringValue(row.tags))) {
        tagDistribution[tag] = (tagDistribution[tag] ?? 0) + 1;
        tagSet.add(tag.toLowerCase());
      }
    }
    const uncoveredPaths = directories.filter((dir) => {
      const parts = dir
        .replace(/\/$/, "")
        .split("/")
        .map((part) => part.toLowerCase())
        .filter(Boolean);
      return parts.length > 0 && !parts.some((part) => tagSet.has(part));
    });
    yield* Effect.sync(() =>
      printJson({
        root,
        uncovered_paths: uncoveredPaths,
        tag_distribution: tagDistribution,
      }),
    );
  });
}

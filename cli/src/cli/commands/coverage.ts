import { resolve } from "node:path";

import {
  coverageMemoriesSelect,
  coverageReport,
} from "@machine-memory/contract";
import { Effect } from "effect";

import { getFlagValue } from "../../cli-utils";
import { jsonObject } from "../../json";
import { loadPathTagMap } from "../../path-tags";
import { repositoryForCurrentDirectory } from "../../repository";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";
import { collectDirectoriesEffect, stringValue } from "../shared";

export function handleCoverageCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { flags } = commandCtx;
    const database = requireDatabase(commandCtx);
    const root = resolve(process.cwd(), getFlagValue(flags, "--root") ?? ".");
    const directories = yield* collectDirectoriesEffect(
      root,
      commandCtx.fileSystem,
    );
    const query = coverageMemoriesSelect(repositoryForCurrentDirectory());
    const rows = yield* database.all(query.sql, query.params);
    const report = coverageReport(
      directories,
      rows.map((row) => ({
        text: stringValue(jsonObject(row)?.text),
        tags: stringValue(jsonObject(row)?.tags),
      })),
      yield* loadPathTagMap(database),
    );
    yield* Effect.sync(() => {
      if (commandCtx.outputMode.quiet) {
        return;
      }
      printCommandOutput(commandCtx, { root, ...report });
    });
  });
}

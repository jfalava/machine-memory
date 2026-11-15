import { resolve } from "node:path";

import { coverageReport } from "@machine-memory/contract";
import { Effect } from "effect";

import { getFlagValue } from "../../cli-utils";
import { jsonObject } from "../../json";
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
    const rows = yield* database.all(
      "SELECT tags FROM memories WHERE repository = ? AND status = 'active'",
      [repositoryForCurrentDirectory()],
    );
    const report = coverageReport(
      directories,
      rows.map((row) => stringValue(jsonObject(row)?.tags)),
    );
    yield* Effect.sync(() => {
      if (commandCtx.outputMode.quiet) {
        return;
      }
      printCommandOutput(commandCtx, { root, ...report });
    });
  });
}

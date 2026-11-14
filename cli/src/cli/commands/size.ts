import { embeddingSizeReport } from "@machine-memory/contract";
import { Effect } from "effect";

import { getFlagValue } from "../../cli-utils";
import { commandError } from "../../effect/errors";
import { SIZE_USAGE } from "../features/memory/usage";
import type { CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";
import { parseContentFromFileFlag } from "../shared";

/**
 * Preflights the size limit for a prospective memory without touching the
 * database: UTF-8 bytes of the embedded text (content, tags, context) against
 * the cap, with each field's share. Exits 1 when over budget.
 */
export function handleSizeCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { flags } = commandCtx;
    const fail = (message: string) =>
      Effect.fail(commandError("size", message, undefined));
    const contentFromArg = commandCtx.positionals[0];
    const contentFromFile = yield* parseContentFromFileFlag(
      flags,
      commandCtx.fileSystem,
    );
    if (contentFromArg && contentFromFile !== undefined) {
      return yield* fail(`Usage: ${SIZE_USAGE}`);
    }
    const content = contentFromFile ?? contentFromArg;
    if (!content) {
      return yield* fail(`Usage: ${SIZE_USAGE}`);
    }
    const size = embeddingSizeReport({
      content,
      tags: getFlagValue(flags, "--tags") ?? "",
      context: getFlagValue(flags, "--context") ?? "",
    });
    yield* Effect.sync(() => {
      printCommandOutput(
        { command: "size", outputMode: commandCtx.outputMode },
        size,
      );
      if (!size.within_budget) {
        process.exitCode = 1;
      }
    });
  });
}

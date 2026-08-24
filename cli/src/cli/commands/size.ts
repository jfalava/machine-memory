import { Effect } from "effect";
import { getFlagValue } from "../../cli-utils";
import { commandError, type CommandError } from "../../effect/errors";
import {
  collectPositionalArgs,
  parseContentFromFileFlag,
  requireCertainty,
  requireMemoryType,
} from "../shared";
import { memoryVectorEmbeddingParts } from "../../effect/vectorize";
import type { CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";
import {
  embeddingSizeReport,
  measureEmbeddingFit,
} from "../features/memory/size-report";
import { SIZE_FLAGS_WITH_VALUES, SIZE_USAGE } from "../features/memory/usage";

/**
 * Preflights the embedding budget for a prospective memory without touching
 * the database: reports the BGE token count, the Worker's byte+2 estimate,
 * pass/fail per limit, and which limit binds. Exits 1 when over budget.
 */
export function handleSizeCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args } = commandCtx;
    const fail = (message: string) =>
      Effect.fail(commandError("size", message, undefined) as CommandError);
    const positional = collectPositionalArgs(args, SIZE_FLAGS_WITH_VALUES);
    const contentFromArg = positional[0];
    const contentFromFile = yield* parseContentFromFileFlag(
      args,
      commandCtx.fileSystem,
    );
    if (contentFromArg && contentFromFile !== undefined) {
      return yield* fail(`Usage: ${SIZE_USAGE}`);
    }
    const content = contentFromFile ?? contentFromArg;
    if (!content) {
      return yield* fail(`Usage: ${SIZE_USAGE}`);
    }
    const breakdown = yield* measureEmbeddingFit(
      memoryVectorEmbeddingParts({
        id: "0",
        repository: "",
        content,
        tags: getFlagValue(args, "--tags") ?? "",
        context: getFlagValue(args, "--context") ?? "",
        memory_type: requireMemoryType(args) ?? "convention",
        status: "active",
        certainty: requireCertainty(args) ?? "inferred",
      }),
    );
    yield* Effect.sync(() => {
      printCommandOutput(
        { command: "size", outputMode: commandCtx.outputMode },
        embeddingSizeReport(breakdown),
      );
      if (!breakdown.within_limit) {
        process.exitCode = 1;
      }
    });
  });
}

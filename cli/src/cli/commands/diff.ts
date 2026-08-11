import { Effect } from "effect";
import { usageError } from "../../cli-utils";
import { getMemoryById, stringValue } from "../shared";
import { compareFact } from "../features/memory/compare";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";

export function handleDiffCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const idRaw = commandCtx.args[0];
    const fact = commandCtx.args.slice(1).join(" ").trim();
    if (!idRaw || !fact) {
      usageError("Usage: diff <id> <new_content>");
    }
    const id = Number(idRaw);
    if (!Number.isInteger(id)) {
      usageError(`Invalid id: ${idRaw}`);
    }
    const memory = yield* getMemoryById(requireDatabase(commandCtx), id);
    yield* Effect.sync(() => {
      if (!memory) {
        printCommandOutput(commandCtx, { error: "Not found" });
        return;
      }
      const result = compareFact(stringValue(memory.content), fact);
      printCommandOutput(commandCtx, {
        id,
        conflict: result.conflict,
        similarity: result.similarity,
        added_terms: result.addedTerms,
        removed_terms: result.removedTerms,
      });
    });
  });
}

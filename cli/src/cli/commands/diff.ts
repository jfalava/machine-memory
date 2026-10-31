import { compareMemoryFact, droppedDetails } from "@machine-memory/contract";
import { Effect } from "effect";

import { usageError } from "../../cli-utils";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";
import { getMemoryById, stringValue } from "../shared";

export function handleDiffCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const idRaw = commandCtx.positionals[0];
    const fact = commandCtx.positionals.slice(1).join(" ").trim();
    if (!idRaw || !fact) {
      usageError("Usage: diff <id> <new_content>");
    }
    const id = Number(idRaw);
    if (!Number.isInteger(id)) {
      usageError(`Invalid id: ${idRaw}`);
    }
    const memory = yield* getMemoryById(requireDatabase(commandCtx), id);
    yield* Effect.sync(() => {
      if (commandCtx.outputMode.quiet) {
        return;
      }
      if (!memory) {
        printCommandOutput(commandCtx, { error: "Not found" });
        return;
      }
      const result = compareMemoryFact(stringValue(memory.content), fact);
      printCommandOutput(commandCtx, {
        id,
        conflict: result.conflict,
        similarity: result.similarity,
        added_terms: result.added_terms,
        removed_terms: result.removed_terms,
        dropped: droppedDetails(stringValue(memory.content), fact),
      });
    });
  });
}

import { compareMemoryFact } from "@machine-memory/contract";
import { Effect } from "effect";

import { usageError } from "../../cli-utils";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";
import { getMemoryById, stringValue } from "../shared";

function parseFactArgs(positionals: string[], usage: string) {
  const idRaw = positionals[0];
  const fact = positionals.slice(1).join(" ").trim();
  if (!idRaw || !fact) {
    usageError(usage);
  }
  const id = Number(idRaw);
  if (!Number.isInteger(id)) {
    usageError(`Invalid id: ${idRaw}`);
  }
  return { id, fact };
}

export function handleVerifyCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { id, fact } = parseFactArgs(
      commandCtx.positionals,
      "Usage: verify <id> <fact>",
    );
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
      printCommandOutput(
        commandCtx,
        result.conflict
          ? {
              id,
              ok: false,
              result: "conflict",
              warning: "Conflict",
              similarity: result.similarity,
            }
          : {
              id,
              ok: true,
              result: "consistent",
              similarity: result.similarity,
            },
      );
    });
  });
}

import { Effect } from "effect";
import { printJson, usageError } from "../../cli-utils";
import { getMemoryById, stringValue } from "../shared";
import { compareFact } from "../features/memory/compare";
import { requireDatabase, type CommandContext } from "../runtime/context";

function parseFactArgs(args: string[], usage: string) {
  const idRaw = args[0];
  const fact = args.slice(1).join(" ").trim();
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
      commandCtx.args,
      "Usage: verify <id> <fact>",
    );
    const memory = yield* getMemoryById(requireDatabase(commandCtx), id);
    yield* Effect.sync(() => {
      if (!memory) {
        printJson({ error: "Not found" });
        return;
      }
      const result = compareFact(stringValue(memory.content), fact);
      printJson(
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

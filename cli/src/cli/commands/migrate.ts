import { Effect } from "effect";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";

export function handleMigrateCommand(commandContext: CommandContext) {
  // Opening the write-capable database applies schema migrations before the
  // handler runs. Requiring it here makes the explicit command do real work.
  requireDatabase(commandContext);
  return Effect.sync(() =>
    printCommandOutput(commandContext, { status: "ok", migrated: true }),
  );
}

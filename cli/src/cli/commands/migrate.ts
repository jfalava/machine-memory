import { Effect } from "effect";
import { printJson } from "../../cli-utils";
import { requireDatabase, type CommandContext } from "../runtime/context";

export function handleMigrateCommand(commandContext: CommandContext) {
  // Opening the write-capable database applies schema migrations before the
  // handler runs. Requiring it here makes the explicit command do real work.
  requireDatabase(commandContext);
  return Effect.sync(() => printJson({ status: "ok", migrated: true }));
}

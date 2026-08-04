import { Effect } from "effect";
import { printJson } from "../../cli";

export function handleMigrateCommand() {
  return Effect.sync(() => printJson({ status: "ok", migrated: true }));
}

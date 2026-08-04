import { Effect } from "effect";
import { printJson } from "../../cli-utils";

export function handleMigrateCommand() {
  return Effect.sync(() => printJson({ status: "ok", migrated: true }));
}

import { Effect } from "effect";
import { printJson, usageError } from "../../cli-utils";
import { normalizeSqliteRow } from "../shared";
import { requireDatabase, type CommandContext } from "../runtime/context";

export function handleGcCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args } = commandCtx;
    const database = requireDatabase(commandCtx);
    if (!args.includes("--dry-run")) {
      usageError("Usage: gc --dry-run");
    }
    const rows = yield* database.all(
      `SELECT * FROM memories
       WHERE status = 'active'
         AND expires_after_days IS NOT NULL
         AND datetime(updated_at, '+' || expires_after_days || ' days') <= datetime('now')
       ORDER BY updated_at ASC`,
    );
    const expired = rows.map((row) => normalizeSqliteRow(row));
    yield* Effect.sync(() =>
      printJson({ dry_run: true, count: expired.length, expired }),
    );
  });
}

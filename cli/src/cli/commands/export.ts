import { Effect } from "effect";
import {
  applySqlFilters,
  normalizeSqliteRow,
  parseCommonFilters,
  parseSinceDate,
  sqliteDateForComparison,
} from "../shared";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";

export function handleExportCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args } = commandCtx;
    const database = requireDatabase(commandCtx);
    const filters = parseCommonFilters(args);
    const since = parseSinceDate(args);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    applySqlFilters(clauses, params, filters, { defaultActiveOnly: true });
    if (since) {
      clauses.push("updated_at >= ?");
      params.push(sqliteDateForComparison(since));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = yield* database.all(
      `SELECT * FROM memories ${where} ORDER BY updated_at DESC, id DESC`,
      params,
    );
    yield* Effect.sync(() =>
      printCommandOutput(
        commandCtx,
        rows.map((row) => normalizeSqliteRow(row)),
      ),
    );
  });
}

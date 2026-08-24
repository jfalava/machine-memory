import { Effect } from "effect";
import { printJson } from "../../cli-utils";
import {
  applySqlFilters,
  normalizeSqliteRow,
  parseCommonFilters,
  parseSinceDate,
  sqliteDateForComparison,
} from "../shared";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { hasMinimalOutput, printCommandOutput } from "../runtime/output";

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
    const fetchedRows = yield* database.all(
      `SELECT * FROM memories ${where} ORDER BY updated_at DESC, id DESC`,
      params,
    );
    yield* Effect.sync(() => {
      const rows = fetchedRows.map((row) => normalizeSqliteRow(row));
      if (commandCtx.outputMode.quiet) {
        return;
      }
      if (hasMinimalOutput(commandCtx.outputMode)) {
        printJson({
          count: rows.length,
          ids: rows.map((row) => Number(row.id)),
        });
        return;
      }
      printCommandOutput(commandCtx, rows);
    });
  });
}

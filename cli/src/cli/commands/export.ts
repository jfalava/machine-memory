import { sqliteTimestamp } from "@machine-memory/contract";
import { Effect } from "effect";

import { appendWriterFilter, requestedWriter } from "../../attribution";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printRead, readEnvelope } from "../runtime/output";
import {
  applySqlFilters,
  normalizeSqliteRow,
  parseCommonFilters,
  parseSinceDate,
  readScope,
} from "../shared";

export function handleExportCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { flags } = commandCtx;
    const database = requireDatabase(commandCtx);
    const filters = parseCommonFilters(flags);
    const since = parseSinceDate(flags);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    applySqlFilters(clauses, params, filters, { defaultActiveOnly: true });
    if (since) {
      clauses.push("updated_at >= ?");
      params.push(sqliteTimestamp(since));
    }
    appendWriterFilter(clauses, params, requestedWriter(flags));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const fetchedRows = yield* database.all(
      `SELECT * FROM memories ${where} ORDER BY updated_at DESC, id DESC`,
      params,
    );
    const rows = fetchedRows.map((row) => normalizeSqliteRow(row));
    const scope = yield* readScope(database, rows.length);
    yield* Effect.sync(() => {
      printRead(
        commandCtx,
        rows,
        readEnvelope(commandCtx.outputMode, scope, rows),
      );
    });
  });
}

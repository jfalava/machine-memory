import {
  decodeRequest,
  normalizeStoredMemoryRow,
  StoredMemoryRowSchema,
} from "@machine-memory/contract";
import { Effect } from "effect";

import { usageError } from "../../cli-utils";
import { commandError } from "../../effect/errors";
import { memoryVectorEmbeddingParts } from "../../effect/vectorize";
import { jsonNumber, jsonObject, type JsonObject } from "../../json";
import { repositoryForCurrentDirectory } from "../../repository";
import {
  assertEmbeddingFit,
  measureEmbeddingFit,
} from "../features/memory/size-report";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";
import {
  normalizeSqliteRow,
  parseIntegerFlag,
  parseResultLimit,
} from "../shared";

function positionalId(args: string[], usage: string): number {
  const raw = args[0];
  const id = raw === undefined ? undefined : Number(raw);
  if (id === undefined || !Number.isInteger(id) || id <= 0) {
    usageError(usage);
  }
  return id;
}

function historyRow(value: JsonObject): JsonObject {
  const row = normalizeSqliteRow(value);
  const memoryId = jsonNumber(row.memory_id) ?? 0;
  row.id = memoryId;
  row.revision_id = Number(row.revision_id ?? 0);
  row.operation = String(row.operation ?? "update");
  row.snapshot_at = String(row.snapshot_at ?? "");
  return row;
}

export function handleHistoryCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const database = requireDatabase(commandCtx);
    const id = positionalId(
      commandCtx.args,
      "Usage: history <id> [--limit <n>] [--offset <n>]",
    );
    const limit = parseResultLimit(commandCtx.args);
    const offset = parseIntegerFlag(commandCtx.args, "--offset") ?? 0;
    if (offset < 0) {
      usageError("--offset must be a non-negative integer");
    }
    const repository = repositoryForCurrentDirectory();
    const rows = yield* database.all(
      `SELECT * FROM memory_history
       WHERE repository = ? AND memory_id = ?
       ORDER BY revision_id DESC LIMIT ? OFFSET ?`,
      [repository, id, limit, offset],
    );
    const countRow = yield* database.get(
      "SELECT COUNT(*) AS total_count FROM memory_history WHERE repository = ? AND memory_id = ?",
      [repository, id],
    );
    const current = yield* database.get(
      "SELECT update_count FROM memories WHERE repository = ? AND id = ?",
      [repository, id],
    );
    const results = rows.map((row) => historyRow(jsonObject(row) ?? {}));
    yield* Effect.sync(() => {
      if (commandCtx.outputMode.quiet) {
        return;
      }
      const totalCount = jsonNumber(jsonObject(countRow)?.total_count) ?? 0;
      printCommandOutput(commandCtx, {
        repository,
        id,
        current_update_count:
          jsonNumber(jsonObject(current)?.update_count) ?? null,
        count: results.length,
        total_count: totalCount,
        offset,
        limit,
        has_more: offset + results.length < totalCount,
        results,
      });
    });
  });
}

// oxlint-disable-next-line max-statements, complexity -- restore validates a conditional complete-row mutation
export function handleRestoreCommand(commandCtx: CommandContext) {
  // oxlint-disable-next-line max-statements, complexity -- restore validates a conditional complete-row mutation
  return Effect.gen(function* () {
    const database = requireDatabase(commandCtx);
    const id = positionalId(
      commandCtx.args,
      "Usage: restore <id> --revision <revision_id> --expected-update-count <n>",
    );
    const revision = parseIntegerFlag(commandCtx.args, "--revision");
    const expectedUpdateCount = parseIntegerFlag(
      commandCtx.args,
      "--expected-update-count",
    );
    if (
      revision === undefined ||
      revision === null ||
      revision <= 0 ||
      expectedUpdateCount === undefined ||
      expectedUpdateCount === null ||
      expectedUpdateCount < 0
    ) {
      usageError(
        "Usage: restore <id> --revision <revision_id> --expected-update-count <n>",
      );
    }
    const repository = repositoryForCurrentDirectory();
    const history = yield* database.get(
      "SELECT * FROM memory_history WHERE repository = ? AND memory_id = ? AND revision_id = ?",
      [repository, id, revision],
    );
    if (!history) {
      yield* Effect.sync(() => {
        process.exitCode = 1;
        printCommandOutput(commandCtx, {
          error: `No history revision ${revision} found for memory ${id}.`,
        });
      });
      return;
    }
    const decoded = decodeRequest(StoredMemoryRowSchema, {
      ...jsonObject(history),
      id,
    });
    if (!decoded.ok) {
      return yield* commandError(
        "restore",
        `The historical memory is not valid under the current schema: ${decoded.error}`,
      );
    }
    const snapshot = normalizeStoredMemoryRow(decoded.value);
    const current = yield* database.get(
      "SELECT update_count FROM memories WHERE repository = ? AND id = ?",
      [repository, id],
    );
    if (!current) {
      yield* Effect.sync(() => {
        process.exitCode = 1;
        printCommandOutput(commandCtx, { error: "Memory not found." });
      });
      return;
    }
    if (jsonNumber(jsonObject(current)?.update_count) !== expectedUpdateCount) {
      yield* Effect.sync(() => {
        process.exitCode = 1;
        printCommandOutput(commandCtx, {
          error: "Memory changed concurrently; retry.",
        });
      });
      return;
    }
    if (snapshot.status === "active") {
      const breakdown = yield* measureEmbeddingFit(
        memoryVectorEmbeddingParts({ ...snapshot, id: String(id) }),
      );
      yield* Effect.try({
        try: () => assertEmbeddingFit(breakdown, `Memory ${id}`),
        catch: (cause) => commandError("restore", String(cause), cause),
      });
    }
    // Snapshots from a pre-migration remote schema carry no evidence columns.
    const withEvidence = jsonObject(history)?.evidence !== undefined;
    const evidenceSets = withEvidence
      ? ", evidence = ?, validation_gaps = ?"
      : "";
    const evidenceParams = withEvidence
      ? [
          JSON.stringify(snapshot.evidence),
          JSON.stringify(snapshot.validation_gaps),
        ]
      : [];
    const restored = yield* database.get(
      `UPDATE memories SET content = ?, tags = ?, context = ?, memory_type = ?, status = ?, superseded_by = ?, source_agent = ?, last_updated_by = 'restore', update_count = COALESCE(update_count, 0) + 1, certainty = ?, refs = ?, expires_after_days = ?, created_at = ?, updated_at = datetime('now')${evidenceSets}
       WHERE repository = ? AND id = ? AND update_count = ? RETURNING *`,
      [
        snapshot.content,
        snapshot.tags,
        snapshot.context,
        snapshot.memory_type,
        snapshot.status,
        snapshot.superseded_by,
        snapshot.source_agent,
        snapshot.certainty,
        JSON.stringify(snapshot.refs),
        snapshot.expires_after_days,
        snapshot.created_at,
        ...evidenceParams,
        repository,
        id,
        expectedUpdateCount,
      ],
    );
    yield* Effect.sync(() => {
      if (!restored) {
        process.exitCode = 1;
        printCommandOutput(commandCtx, {
          error: "Memory changed concurrently; retry.",
        });
        return;
      }
      printCommandOutput(commandCtx, {
        written_to: repository,
        id,
        restored_revision_id: revision,
        memory: normalizeSqliteRow(restored),
      });
    });
  });
}

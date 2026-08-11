import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DB_PATH } from "./constants";
import {
  canonicalizeCertainty,
  isMemoryStatus,
  isMemoryType,
  normalizeSqliteRow,
  parseStoredRefs,
  sqliteDateForComparison,
  stringValue,
} from "./cli/shared";

export type RemoteMigrationRow = {
  readonly source_id: number;
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memory_type: string;
  readonly status: string;
  readonly superseded_by_source_id: number | null;
  readonly source_agent: string;
  readonly last_updated_by: string;
  readonly update_count: number;
  readonly certainty: string;
  readonly refs: string;
  readonly expires_after_days: number | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
};

export type RemoteMigrationLink = {
  readonly target_id: number;
  readonly superseded_by_target_id: number;
};

const SOURCE_COLUMNS = [
  "id",
  "repository",
  "content",
  "tags",
  "context",
  "memory_type",
  "status",
  "superseded_by",
  "source_agent",
  "last_updated_by",
  "update_count",
  "certainty",
  "refs",
  "expires_after_days",
  "created_at",
  "updated_at",
] as const;

function sourceError(message: string, cause?: unknown): Error {
  return new Error(message, cause === undefined ? undefined : { cause });
}

function sourceDate(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return null;
  }
  return sqliteDateForComparison(value);
}

function sourceInteger(
  value: unknown,
  label: string,
  options: { nullable?: boolean } = {},
): number | null {
  if (value === null || value === undefined || value === "") {
    if (options.nullable) {
      return null;
    }
    throw sourceError(`${label} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw sourceError(`${label} must be a safe integer.`);
  }
  return parsed;
}

function normalizeSourceRow(row: unknown, index: number): RemoteMigrationRow {
  const normalized = normalizeSqliteRow(row);
  const sourceId = sourceInteger(normalized.id, `Source row ${index + 1} id`);
  if (sourceId === null || sourceId < 1) {
    throw sourceError(`Source row ${index + 1} has an invalid id.`);
  }

  const content = stringValue(normalized.content);
  if (!content) {
    throw sourceError(`Source row ${sourceId} has empty content.`);
  }

  const memoryType = stringValue(normalized.memory_type, "convention");
  if (!isMemoryType(memoryType)) {
    throw sourceError(
      `Source row ${sourceId} has invalid memory_type '${memoryType}'.`,
    );
  }

  const status = stringValue(normalized.status, "active");
  if (!isMemoryStatus(status)) {
    throw sourceError(`Source row ${sourceId} has invalid status '${status}'.`);
  }

  const certainty = canonicalizeCertainty(
    stringValue(normalized.certainty, "inferred"),
  );
  if (!certainty) {
    throw sourceError(`Source row ${sourceId} has invalid certainty.`);
  }

  const updateCount = sourceInteger(
    normalized.update_count ?? 0,
    `Source row ${sourceId} update_count`,
  );
  const expiresAfterDays = sourceInteger(
    normalized.expires_after_days,
    `Source row ${sourceId} expires_after_days`,
    { nullable: true },
  );
  const supersededBy = sourceInteger(
    normalized.superseded_by,
    `Source row ${sourceId} superseded_by`,
    { nullable: true },
  );

  return {
    source_id: sourceId,
    content,
    tags: stringValue(normalized.tags),
    context: stringValue(normalized.context),
    memory_type: memoryType,
    status,
    superseded_by_source_id: supersededBy,
    source_agent: stringValue(normalized.source_agent),
    last_updated_by: stringValue(normalized.last_updated_by),
    update_count: updateCount ?? 0,
    certainty,
    refs: JSON.stringify(parseStoredRefs(normalized.refs)),
    expires_after_days: expiresAfterDays,
    created_at: sourceDate(normalized.created_at),
    updated_at: sourceDate(normalized.updated_at),
  };
}

function tableColumns(database: Database): Set<string> {
  const rows = database.query("PRAGMA table_info(memories)").all() as {
    name?: unknown;
  }[];
  return new Set(
    rows
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter(Boolean),
  );
}

function readSourceRows(
  database: Database,
  columns: Set<string>,
  repository: string,
): unknown[] {
  const selectedColumns = SOURCE_COLUMNS.filter((column) =>
    columns.has(column),
  );
  const select = selectedColumns.join(", ");
  return columns.has("repository")
    ? database
        .query(
          `SELECT ${select} FROM memories WHERE repository = ? ORDER BY id ASC`,
        )
        .all(repository)
    : database.query(`SELECT ${select} FROM memories ORDER BY id ASC`).all();
}

export function resolveMigrationSourcePath(
  requestedPath?: string,
  cwd = process.cwd(),
): string {
  const configured =
    requestedPath?.trim() || process.env["MACHINE_MEMORY_DB_PATH"];
  const sourcePath = configured?.trim() || DB_PATH;
  return isAbsolute(sourcePath) ? sourcePath : resolve(cwd, sourcePath);
}

export function readLocalMigrationRows(
  sourcePath: string,
  repository: string,
): RemoteMigrationRow[] {
  if (!existsSync(sourcePath)) {
    throw sourceError(`Local database file not found: ${sourcePath}`);
  }

  let database: Database;
  try {
    database = new Database(sourcePath, { readonly: true });
  } catch (cause) {
    throw sourceError(`Could not open local database: ${sourcePath}`, cause);
  }

  try {
    const columns = tableColumns(database);
    if (!columns.has("content")) {
      throw sourceError(
        "The local database does not contain a readable memories table.",
      );
    }

    return readSourceRows(database, columns, repository).map((row, index) =>
      normalizeSourceRow(row, index),
    );
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Source row")) {
      throw cause;
    }
    if (
      cause instanceof Error &&
      cause.message.startsWith("The local database")
    ) {
      throw cause;
    }
    throw sourceError(`Could not read local database: ${sourcePath}`, cause);
  } finally {
    database.close();
  }
}

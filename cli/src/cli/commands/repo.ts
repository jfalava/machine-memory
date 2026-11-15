import { Effect } from "effect";
import { Command } from "effect/cli";
import pc from "picocolors";

import { currentWriter } from "../../attribution";
import { hasFlag, usageError } from "../../cli-utils";
import { commandError } from "../../effect/errors";
import { jsonNumber, jsonObject, type JsonObject } from "../../json";
import {
  parseRepositorySlug,
  readRepositoryPin,
  repositoryForCurrentDirectory,
  repositorySource,
} from "../../repository";
import {
  booleanFlag,
  booleanSpec,
  effectCommand,
  outputConfig,
  outputSpecs,
  positionalArgs,
} from "../runtime/command";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";
import { stringValue } from "../shared";

const MERGE_USAGE =
  "Usage: repo merge <from> <into> [--dry-run] (--local|--remote)";

/** The slug this checkout resolves to and where it came from; null outside any repository. */
function currentRepository(): JsonObject {
  try {
    return {
      current: repositoryForCurrentDirectory(),
      source: repositorySource(),
      pin: readRepositoryPin() ?? null,
    };
  } catch {
    return { current: null, source: null, pin: null };
  }
}

function handleRepoList(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const database = requireDatabase(commandCtx);
    const rows = yield* database.all(
      `SELECT repository,
              COUNT(*) AS total,
              SUM(status = 'active') AS active,
              SUM(status = 'deprecated') AS deprecated,
              SUM(status = 'superseded_by') AS superseded
       FROM memories GROUP BY repository ORDER BY repository`,
    );
    const results = rows.map((row): JsonObject => {
      const counts = jsonObject(row) ?? {};
      return {
        repository: stringValue(counts.repository),
        total: jsonNumber(counts.total) ?? 0,
        active: jsonNumber(counts.active) ?? 0,
        deprecated: jsonNumber(counts.deprecated) ?? 0,
        superseded: jsonNumber(counts.superseded) ?? 0,
      };
    });
    yield* Effect.sync(() => {
      printCommandOutput(commandCtx, {
        ...currentRepository(),
        count: results.length,
        results,
      });
    });
  });
}

/** `merge:<from>#<id>`: stored as a copy's last_updated_by, so each copy names the memory it came from. */
function mergeMarker(from: string): string {
  return `merge:${from}#`;
}

const COPIED_COLUMNS =
  "content, tags, context, memory_type, status, source_agent, certainty, refs, expires_after_days, evidence, validation_gaps, created_at, updated_at";

function mergeSlugs(positionals: string[]) {
  const [from, into, ...rest] = positionals;
  if (from === undefined || into === undefined || rest.length > 0) {
    usageError(MERGE_USAGE);
  }
  const slugs = {
    from: parseRepositorySlug(from),
    into: parseRepositorySlug(into),
  };
  if (slugs.from === slugs.into) {
    usageError("repo merge needs two different repositories.");
  }
  return slugs;
}

/**
 * Copies the active memories of `from` into `into` and deprecates the
 * originals. A memory's repository cannot change in place: its id and its
 * vector namespace belong to the repository, so a merge writes new ids.
 */
function handleRepoMerge(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const database = requireDatabase(commandCtx);
    const { from, into } = mergeSlugs(commandCtx.positionals);
    const marker = mergeMarker(from);
    // A copy made by an earlier, interrupted merge is not made twice.
    const pending = `repository = ? AND status = 'active' AND NOT EXISTS (
      SELECT 1 FROM memories t WHERE t.repository = ? AND t.last_updated_by = ? || memories.id)`;
    const counted = yield* database.get(
      `SELECT COUNT(*) AS total FROM memories WHERE ${pending}`,
      [from, into, marker],
    );
    const pendingCount = jsonNumber(jsonObject(counted)?.total) ?? 0;
    if (hasFlag(commandCtx.flags, "--dry-run")) {
      yield* Effect.sync(() => {
        printCommandOutput(commandCtx, {
          from,
          into,
          dry_run: true,
          would_copy: pendingCount,
        });
      });
      return;
    }
    yield* database.run(
      `INSERT INTO memories (repository, ${COPIED_COLUMNS}, superseded_by, update_count, last_updated_by)
       SELECT ?, ${COPIED_COLUMNS}, NULL, 0, ? || id
       FROM memories WHERE ${pending} ORDER BY id`,
      [into, marker, from, into, marker],
    );
    const copies = yield* database.all(
      `SELECT id, last_updated_by FROM memories
       WHERE repository = ? AND substr(last_updated_by, 1, ?) = ? ORDER BY id`,
      [into, marker.length, marker],
    );
    const idMap = copies.map((row) => {
      const copy = jsonObject(row) ?? {};
      return {
        from_id: Number(stringValue(copy.last_updated_by).slice(marker.length)),
        into_id: jsonNumber(copy.id) ?? 0,
      };
    });
    const deprecated = yield* database.all(
      `UPDATE memories SET status = 'deprecated', last_updated_by = ?, updated_at = datetime('now'), update_count = COALESCE(update_count, 0) + 1
       WHERE repository = ? AND status = 'active' AND id IN (SELECT value FROM json_each(?)) RETURNING id`,
      [
        currentWriter() || "merge",
        from,
        JSON.stringify(idMap.map((entry) => entry.from_id)),
      ],
    );
    if (idMap.length === 0) {
      return yield* commandError(
        "repo merge",
        `'${from}' has no active memories to merge. Run 'machine-memory repo list' for the repositories that do.`,
      );
    }
    yield* Effect.sync(() => {
      printCommandOutput(commandCtx, {
        from,
        into,
        copied: pendingCount,
        deprecated: deprecated.length,
        id_map: idMap,
        note: `Ids changed: id_map gives each memory's new id in '${into}'. The originals stay in '${from}' as deprecated. Run doctor on '${into}' to find memories the two repositories both held.`,
      });
    });
  });
}

const repoListCommand = effectCommand(
  "list",
  { args: positionalArgs(), ...outputConfig() },
  outputSpecs,
  "read",
  handleRepoList,
);

const repoMergeCommand = effectCommand(
  "merge",
  {
    args: positionalArgs(),
    "dry-run": booleanFlag("dry-run"),
    ...outputConfig(),
  },
  [booleanSpec("dry-run"), ...outputSpecs],
  "write",
  handleRepoMerge,
);

export const repoCommand = Command.make("repo", {}, () =>
  Effect.sync(() => {
    console.info(`${pc.bold("Usage:")} machine-memory repo <list|merge>`);
    console.info(
      `${pc.dim("List:")}  machine-memory repo list (--local|--remote)`,
    );
    console.info(
      `${pc.dim("Merge:")} machine-memory repo merge <from> <into> [--dry-run] (--local|--remote)`,
    );
  }),
).pipe(Command.withSubcommands([repoListCommand, repoMergeCommand]));

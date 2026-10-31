import { execFileSync } from "node:child_process";

import { Effect } from "effect";

import {
  type CommandFlags,
  getFlagValue,
  hasFlag,
  printJson,
} from "../../cli-utils";
import type { JsonObject } from "../../json";
import {
  activeRepositoryOverride,
  repositoryForCurrentDirectory,
} from "../../repository";
import {
  parseStoredEvidence,
  parseStoredValidationGaps,
} from "../features/memory/evidence";
import { requireDatabase, type CommandContext } from "../runtime/context";
import {
  minimalResultSummary,
  printBriefLines,
  printCommandOutput,
} from "../runtime/output";
import {
  normalizeSqliteRow,
  parseResultLimit,
  parseSinceDate,
  sqliteDateForComparison,
  stringValue,
  uniqueLowerPreserveOrder,
} from "../shared";
import {
  buildSuggestSnapshot,
  collectSuggestResults,
  fetchQueryResults,
} from "./memory-read";

const DEFAULT_SINCE_HOURS = 12;
const MAX_TOUCHED_FILES = 20;
const RECENT_LIMIT = 50;

function gitLines(args: string[]): string[] {
  try {
    return String(
      execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Working-tree changes, else the last commit: the files this task touched. */
function touchedFiles(): string[] {
  const working = uniqueLowerPreserveOrder([
    ...gitLines(["diff", "--name-only", "HEAD"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ]);
  return (
    working.length > 0
      ? working
      : gitLines(["show", "--name-only", "--format=", "HEAD"])
  ).slice(0, MAX_TOUCHED_FILES);
}

/**
 * Explicit --files win. Without them, a --repo target is another checkout, so
 * this directory's Git changes say nothing about it.
 */
function checkpointFlags(flags: CommandFlags): CommandFlags {
  if (hasFlag(flags, "--files") || hasFlag(flags, "--files-json")) {
    return flags;
  }
  if (activeRepositoryOverride() !== undefined) {
    return flags;
  }
  const files = touchedFiles();
  return files.length > 0
    ? new Map([...flags, ["--files", files.join(",")]])
    : flags;
}

function sinceTimestamp(flags: CommandFlags): string {
  const explicit = parseSinceDate(flags);
  return sqliteDateForComparison(
    explicit ??
      new Date(Date.now() - DEFAULT_SINCE_HOURS * 3_600_000).toISOString(),
  );
}

function backendFlag(flags: CommandFlags): string {
  return flags.has("--local") ? "--local" : "--remote";
}

function classification(flag: string): JsonObject[] {
  return [
    {
      group: "already_covered",
      action: `Cite the memory ID. Change it only when evidence, scope, or wording is wrong: machine-memory update <id> "<content>" ${flag}`,
    },
    {
      group: "new_durable_knowledge",
      action: `machine-memory add "<content>" --type decision|constraint|preference|reference|gotcha --certainty <c> --evidence <kinds> --validation-gaps <gaps> ${flag}`,
    },
    {
      group: "superseded_or_conflicting",
      action: `machine-memory update <id> "<content>" ${flag} or machine-memory deprecate <id> --superseded-by <id> ${flag}; then follow each review_candidates entry`,
    },
    {
      group: "transient_status",
      action: `Add or update one expiring status record: machine-memory add "<where work stands>" --type status --expires-after-days 14 --upsert-match "<topic>" ${flag}`,
    },
    {
      group: "intentionally_omitted",
      action:
        "State the reason: obvious from code, routine test result, duplicate, or not reusable.",
    },
  ];
}

function reviewFlags(recent: JsonObject[], related: JsonObject[]): JsonObject {
  const active = recent.filter((row) => row.status === "active");
  const ids = (rows: JsonObject[]) => rows.map((row) => Number(row.id));
  return {
    verified_without_evidence: ids(
      active.filter(
        (row) =>
          row.certainty === "verified" &&
          parseStoredEvidence(row.evidence).length === 0,
      ),
    ),
    status_without_expiry: ids(
      active.filter(
        (row) =>
          row.memory_type === "status" &&
          (row.expires_after_days === null ||
            row.expires_after_days === undefined),
      ),
    ),
    verified_with_gaps: ids(
      active.filter(
        (row) =>
          row.certainty === "verified" &&
          parseStoredValidationGaps(row.validation_gaps).length > 0,
      ),
    ),
    related_status: ids(related.filter((row) => row.memory_type === "status")),
    strong_related: ids(
      related.filter((row) => row.match_strength === "strong"),
    ),
  };
}

function recentSummary(row: JsonObject): JsonObject {
  return {
    ...minimalResultSummary(row),
    status: stringValue(row.status, "active"),
    updated_at: stringValue(row.updated_at),
  };
}

export function handleCheckpointCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const flags = checkpointFlags(commandCtx.flags);
    const database = requireDatabase(commandCtx);
    const since = sinceTimestamp(flags);
    const limit = parseResultLimit(flags);
    const recent = (yield* database.all(
      `SELECT * FROM memories WHERE repository = ? AND updated_at >= ?
       ORDER BY updated_at DESC, id DESC LIMIT ${RECENT_LIMIT}`,
      [repositoryForCurrentDirectory(), since],
    )).map((row) => normalizeSqliteRow(row));
    const hasFiles =
      hasFlag(flags, "--files") || hasFlag(flags, "--files-json");
    const snapshot = hasFiles ? buildSuggestSnapshot(flags) : undefined;
    const related = snapshot
      ? yield* collectSuggestResults({ ...commandCtx, flags }, snapshot, {
          explainScore: false,
          limit,
        })
      : [];
    const query = getFlagValue(flags, "--query");
    const queried = query
      ? (yield* fetchQueryResults({ ...commandCtx, flags }, query, {
          explainScore: false,
          limit,
        })).results
      : [];
    const relatedRows = [...related, ...queried];
    yield* Effect.sync(() => {
      const { outputMode } = commandCtx;
      if (outputMode.quiet) {
        printJson({
          recent_ids: recent.map((row) => Number(row.id)),
          related_ids: relatedRows.map((row) => Number(row.id)),
        });
        return;
      }
      if (outputMode.brief) {
        printBriefLines([...recent, ...relatedRows]);
        return;
      }
      const payload: JsonObject = {
        repository: repositoryForCurrentDirectory(),
        since,
        files: snapshot?.files ?? [],
        recent: outputMode.jsonMin ? recent.map(recentSummary) : recent,
        related: related.map(minimalResultSummary),
        review: reviewFlags(recent, relatedRows),
        classification: classification(backendFlag(flags)),
      };
      if (query) {
        payload.query = query;
        payload.query_results = queried.map(minimalResultSummary);
      }
      printCommandOutput(commandCtx, payload);
    });
  });
}

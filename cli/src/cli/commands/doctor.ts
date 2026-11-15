import {
  analyzeMemoryDoctor,
  DEFAULT_STATUS_EXPIRY_DAYS,
  INFORMATIONAL_DOCTOR_KINDS,
  jsonString,
  sqliteDateToMs,
  type MemoryDoctorFinding,
} from "@machine-memory/contract";
import { Effect, Schema } from "effect";

import {
  getFlagValue,
  printJson,
  usageError,
  type CommandFlags,
} from "../../cli-utils";
import type { JsonObject } from "../../json";
import { repositoryForCurrentDirectory } from "../../repository";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";
import {
  parseSinceDate,
  stringValue,
  uniqueLowerPreserveOrder,
} from "../shared";

/** Output group, in print order, for each finding kind contract reports. */
const FINDING_GROUPS = {
  exact_duplicate: "exact_duplicates",
  near_duplicate: "near_duplicates",
  stale_status_overlap: "stale_status_overlaps",
  canonical_thread_overlap: "canonical_thread_overlaps",
  status_missing_expiry: "status_expiry",
  expired_status: "expired_status",
  transient_non_status: "type_boundary",
  status_looks_decision: "type_boundary",
  empty_tags: "tag_hygiene",
  invalid_tags: "tag_hygiene",
  taxonomy_mismatch: "tag_hygiene",
  similar_tags: "similar_tags",
  malformed_refs: "malformed_refs",
  verified_without_evidence: "verified_without_evidence",
  gotcha_overlap: "gotcha_overlaps",
} as const;
type FindingKind = keyof typeof FINDING_GROUPS;
type FindingGroup = (typeof FINDING_GROUPS)[FindingKind];

function isFindingKind(kind: string): kind is FindingKind {
  return Object.hasOwn(FINDING_GROUPS, kind);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

type CommandInput = { finding: MemoryDoctorFinding; update: string };

/** Ready-to-review CLI commands for the findings that have a mechanical fix. */
const SUGGESTED_COMMANDS = {
  exact_duplicate: ({ finding }) =>
    `machine-memory delete ${finding.ids.slice(1).join(",")}`,
  near_duplicate: ({ finding }) =>
    `machine-memory deprecate ${finding.ids[1]} --superseded-by ${finding.ids[0]}`,
  stale_status_overlap: ({ finding }) =>
    `machine-memory deprecate ${finding.ids[0]} --superseded-by ${finding.ids[1]}`,
  expired_status: ({ finding }) => `machine-memory deprecate ${finding.ids[0]}`,
  status_missing_expiry: ({ update }) =>
    `${update} --expires-after-days ${DEFAULT_STATUS_EXPIRY_DAYS}`,
  transient_non_status: ({ update }) =>
    `${update} --type status --expires-after-days ${DEFAULT_STATUS_EXPIRY_DAYS}`,
  status_looks_decision: ({ update }) =>
    `${update} --type decision --expires-after-days null`,
  empty_tags: ({ update }) => `${update} --tags "<tag1,tag2>"`,
  invalid_tags: ({ finding, update }) =>
    `${update} --tags ${shellQuote(jsonString(finding.details.normalized_tags) ?? "")}`,
  taxonomy_mismatch: ({ finding, update }) =>
    `${update} --tags ${shellQuote(jsonString(finding.details.suggested_tags) ?? "")}`,
  malformed_refs: ({ finding, update }) =>
    `${update} --refs ${shellQuote(JSON.stringify(finding.details.suggested_refs ?? []))}`,
} satisfies Partial<Record<FindingKind, (input: CommandInput) => string>>;

type CommandKind = keyof typeof SUGGESTED_COMMANDS;

function hasSuggestedCommand(kind: FindingKind): kind is CommandKind {
  return Object.hasOwn(SUGGESTED_COMMANDS, kind);
}

function suggestedCommand(
  kind: FindingKind,
  finding: MemoryDoctorFinding,
): string | undefined {
  if (!hasSuggestedCommand(kind)) {
    return undefined;
  }
  const build: (input: CommandInput) => string = SUGGESTED_COMMANDS[kind];
  // update changes only the named fields when it is given no content.
  return build({ finding, update: `machine-memory update ${finding.ids[0]}` });
}

function outputFinding(
  finding: MemoryDoctorFinding,
  command: string | undefined,
): JsonObject {
  const item: JsonObject = { kind: finding.kind };
  if (finding.ids.length === 1) {
    item.id = finding.ids[0];
  }
  if (finding.kind === "gotcha_overlap" || finding.kind === "similar_tags") {
    item.ids = [...finding.ids];
  }
  Object.assign(item, finding.details);
  if (command !== undefined) {
    item.suggested_command = command;
  }
  return item;
}

const GROUP_ORDER = [...new Set(Object.values(FINDING_GROUPS))];
const INFORMATIONAL_GROUPS = new Set<string>(
  INFORMATIONAL_DOCTOR_KINDS.flatMap((kind) =>
    isFindingKind(kind) ? [FINDING_GROUPS[kind]] : [],
  ),
);

/** --only: finding kinds or output groups, comma-separated; undefined when absent. */
function parseOnly(flags: CommandFlags): Set<string> | undefined {
  const raw = getFlagValue(flags, "--only");
  if (raw === undefined) {
    return undefined;
  }
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const known = new Set<string>([
    ...Object.keys(FINDING_GROUPS),
    ...GROUP_ORDER,
  ]);
  const unknown = names.filter((name) => !known.has(name));
  if (names.length === 0 || unknown.length > 0) {
    usageError(
      `--only takes finding kinds or groups, comma-separated${unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""}. Kinds: ${Object.keys(FINDING_GROUPS).join(", ")}.`,
    );
  }
  return new Set(names);
}

/**
 * The findings to report. --only names them; without it, informational kinds
 * are left to the counts. --since keeps findings that involve a memory
 * changed since then, which separates new findings from the backlog.
 */
function selectFindings(
  findings: readonly MemoryDoctorFinding[],
  flags: CommandFlags,
  rows: readonly JsonObject[],
): MemoryDoctorFinding[] {
  const only = parseOnly(flags);
  const since = parseSinceDate(flags);
  const sinceMs = since === undefined ? undefined : Date.parse(since);
  const changed = new Set(
    rows.flatMap((row) =>
      sinceMs !== undefined &&
      (sqliteDateToMs(stringValue(row.updated_at)) ?? 0) >= sinceMs
        ? [Number(row.id)]
        : [],
    ),
  );
  return findings.filter((finding) => {
    if (!isFindingKind(finding.kind)) {
      return false;
    }
    const named =
      only === undefined
        ? !INFORMATIONAL_DOCTOR_KINDS.includes(finding.kind)
        : only.has(finding.kind) || only.has(FINDING_GROUPS[finding.kind]);
    return (
      named &&
      (sinceMs === undefined || finding.ids.some((id) => changed.has(id)))
    );
  });
}

/** Per kind: how many findings, and the ids they involve. */
function findingsByKind(findings: readonly MemoryDoctorFinding[]) {
  const counts: Record<string, number> = {};
  const ids: Record<string, number[]> = {};
  for (const finding of findings) {
    counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
    ids[finding.kind] = [
      ...new Set([...(ids[finding.kind] ?? []), ...finding.ids]),
    ].toSorted((a, b) => a - b);
  }
  return { counts, ids };
}

function groupFindings(findings: readonly MemoryDoctorFinding[]) {
  const groups = new Map<FindingGroup, JsonObject[]>(
    GROUP_ORDER.map((group) => [group, []]),
  );
  const commandsByGroup = new Map<FindingGroup, string[]>(
    GROUP_ORDER.map((group) => [group, []]),
  );
  for (const finding of findings) {
    if (!isFindingKind(finding.kind)) {
      continue;
    }
    const group = FINDING_GROUPS[finding.kind];
    const command = suggestedCommand(finding.kind, finding);
    groups.get(group)?.push(outputFinding(finding, command));
    if (command !== undefined) {
      commandsByGroup.get(group)?.push(command);
    }
  }
  const commands = GROUP_ORDER.flatMap(
    (group) => commandsByGroup.get(group) ?? [],
  );
  return { groups, commands: uniqueLowerPreserveOrder(commands) };
}

/** How many informational findings exist; `doctor --only <kind>` lists them. */
function informationalCounts(countsByKind: Readonly<Record<string, number>>) {
  return Object.fromEntries(
    INFORMATIONAL_DOCTOR_KINDS.map((kind) => [kind, countsByKind[kind] ?? 0]),
  );
}

const StoredRowsSchema = Schema.Array(
  Schema.Record(Schema.String, Schema.Json),
);

export function handleDoctorCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const repository = repositoryForCurrentDirectory();
    // Stored rows are JSON values by construction; a mismatch is a defect.
    const rows = yield* Schema.decodeUnknownEffect(StoredRowsSchema)(
      yield* requireDatabase(commandCtx).all(
        `SELECT * FROM memories
         WHERE repository = ?
           AND status = 'active'
         ORDER BY updated_at DESC, id DESC`,
        [repository],
      ),
    ).pipe(Effect.orDie);
    const result = analyzeMemoryDoctor(repository, rows);
    const selected = selectFindings(result.findings, commandCtx.flags, rows);
    const { groups, commands } = groupFindings(selected);
    yield* Effect.sync(() => {
      if (commandCtx.outputMode.jsonMin || commandCtx.outputMode.quiet) {
        const byKind = findingsByKind(selected);
        printJson({
          repository,
          checked: result.checked,
          count: selected.length,
          counts_by_kind: byKind.counts,
          ids_by_kind: byKind.ids,
          informational_counts: informationalCounts(result.counts_by_kind),
          suggested_commands_count: commands.length,
        });
        return;
      }
      if (commandCtx.outputMode.brief) {
        console.info(commands.join("\n"));
        return;
      }
      const summary: JsonObject = { checked: result.checked };
      for (const [group, items] of groups) {
        // Informational groups are counted in informational_counts instead.
        if (items.length > 0 || !INFORMATIONAL_GROUPS.has(group)) {
          summary[group === "status_expiry" ? "status_missing_expiry" : group] =
            items.length;
        }
      }
      summary.suggested_commands = commands.length;
      printCommandOutput(commandCtx, {
        repository,
        summary,
        informational_counts: informationalCounts(result.counts_by_kind),
        findings: Object.fromEntries(groups),
        suggested_commands: commands,
      });
    });
  });
}

import {
  analyzeMemoryDoctor,
  DEFAULT_STATUS_EXPIRY_DAYS,
  jsonNumber,
  jsonString,
  type MemoryDoctorFinding,
} from "@machine-memory/contract";
import { Effect, Schema } from "effect";

import { printJson } from "../../cli-utils";
import type { JsonObject } from "../../json";
import { repositoryForCurrentDirectory } from "../../repository";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";
import { uniqueLowerPreserveOrder } from "../shared";

/** Output group, in print order, for each finding kind contract reports. */
const FINDING_GROUPS = {
  exact_duplicate: "exact_duplicates",
  near_duplicate: "near_duplicates",
  stale_status_overlap: "stale_status_overlaps",
  canonical_thread_overlap: "canonical_thread_overlaps",
  status_missing_expiry: "status_expiry",
  transient_non_status: "type_boundary",
  status_looks_decision: "type_boundary",
  empty_tags: "tag_hygiene",
  invalid_tags: "tag_hygiene",
  taxonomy_mismatch: "tag_hygiene",
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
  canonical_thread_overlap: ({ finding }) =>
    `machine-memory deprecate ${finding.ids[0]} --superseded-by ${finding.ids[1]}`,
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
  content: string,
): string | undefined {
  if (!hasSuggestedCommand(kind)) {
    return undefined;
  }
  const build: (input: CommandInput) => string = SUGGESTED_COMMANDS[kind];
  const update = `machine-memory update ${finding.ids[0]} ${shellQuote(content)}`;
  return build({ finding, update });
}

function outputFinding(
  finding: MemoryDoctorFinding,
  command: string | undefined,
): JsonObject {
  const item: JsonObject = { kind: finding.kind };
  if (finding.ids.length === 1) {
    item.id = finding.ids[0];
  }
  if (finding.kind === "gotcha_overlap") {
    item.ids = [...finding.ids];
  }
  Object.assign(item, finding.details);
  if (command !== undefined) {
    item.suggested_command = command;
  }
  return item;
}

const GROUP_ORDER = [...new Set(Object.values(FINDING_GROUPS))];

function groupFindings(
  findings: readonly MemoryDoctorFinding[],
  contentById: ReadonlyMap<number, string>,
) {
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
    const command = suggestedCommand(
      finding.kind,
      finding,
      contentById.get(finding.ids[0] ?? 0) ?? "",
    );
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
    const contentById = new Map(
      rows.map(
        (row) =>
          [jsonNumber(row.id) ?? 0, jsonString(row.content) ?? ""] as const,
      ),
    );
    const { groups, commands } = groupFindings(result.findings, contentById);
    yield* Effect.sync(() => {
      if (commandCtx.outputMode.jsonMin || commandCtx.outputMode.quiet) {
        printJson({
          count: result.count,
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
        summary[group === "status_expiry" ? "status_missing_expiry" : group] =
          items.length;
      }
      summary.suggested_commands = commands.length;
      printCommandOutput(commandCtx, {
        summary,
        findings: Object.fromEntries(groups),
        suggested_commands: commands,
      });
    });
  });
}

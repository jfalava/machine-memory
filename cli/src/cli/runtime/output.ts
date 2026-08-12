import { Flag, GlobalFlag } from "effect/unstable/cli";
import { printJson } from "../../cli-utils";
import type { CommonFilters } from "../../constants";
import { normalizeCertaintyValue, parseTags, stringValue } from "../shared";
import { renderPretty } from "./pretty";
import type { JsonObject, JsonValue } from "../../json";

export const prettyOutput = GlobalFlag.setting("pretty")({
  flag: Flag.boolean("pretty").pipe(
    Flag.withDescription("Render human-readable output for machine commands"),
  ),
});

export type OutputMode = {
  brief: boolean;
  jsonMin: boolean;
  noConflicts: boolean;
  pretty: boolean;
  quiet: boolean;
};

export function parseOutputMode(args: string[], pretty = false): OutputMode {
  return {
    brief: args.includes("--brief"),
    jsonMin: args.includes("--json-min"),
    noConflicts: args.includes("--no-conflicts"),
    pretty,
    quiet: args.includes("--quiet"),
  };
}

export function prettyOutputEnabled(mode: OutputMode): boolean {
  return mode.pretty && !mode.brief && !mode.jsonMin && !mode.quiet;
}

export function outputModeForPretty(pretty: boolean): OutputMode {
  return parseOutputMode([], pretty);
}

export function printCommandOutput(
  context: { command: string; outputMode: OutputMode },
  data: JsonValue,
) {
  if (prettyOutputEnabled(context.outputMode)) {
    console.info(renderPretty(context.command, data));
    return;
  }
  printJson(data);
}

export function hasMinimalOutput(mode: OutputMode): boolean {
  return mode.brief || mode.jsonMin || mode.quiet;
}

function briefTagText(tags: JsonValue | undefined): string {
  const parsed = parseTags(stringValue(tags));
  return parsed.length === 0
    ? "(#none)"
    : `(${parsed.map((tag) => `#${tag}`).join(" ")})`;
}

function formatBriefMemoryLine(row: JsonObject): string {
  const id = Number(row.id ?? 0);
  const certainty = normalizeCertaintyValue(row.certainty);
  const type = stringValue(row.memory_type, "convention");
  const content = stringValue(row.content).replace(/\s+/g, " ").trim();
  return `[${id}] <${certainty}> <${type}>: ${content} ${briefTagText(row.tags)}`;
}

export function printBriefLines(rows: JsonObject[]) {
  console.info(rows.map(formatBriefMemoryLine).join("\n"));
}

export function minimalResultSummary(row: JsonObject): JsonObject {
  return {
    id: Number(row.id ?? 0),
    score: Number(row.score ?? 0),
    memory_type: stringValue(row.memory_type, "convention"),
    certainty: normalizeCertaintyValue(row.certainty),
    tags: parseTags(stringValue(row.tags)),
  } satisfies JsonObject;
}

export function queryEmptyResultPayload(
  term: string,
  filters: CommonFilters,
  queryTokens: string[],
) {
  return {
    results: [],
    search_term: term,
    derived_terms: queryTokens,
    filters: {
      tags: filters.tag ?? null,
      type: filters.memoryType ?? null,
      certainty: filters.certainty ?? null,
      include_deprecated: filters.includeDeprecated,
    },
    hints: [
      "Try broader keywords or synonyms.",
      "Use --include-deprecated to include superseded/archived memories.",
      "Narrow with --tags/--type/--certainty when you know the scope.",
    ],
  };
}

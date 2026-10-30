import { Flag, GlobalFlag } from "effect/cli";

import { printJson } from "../../cli-utils";
import type { CommonFilters } from "../../constants";
import type { JsonObject, JsonValue } from "../../json";
import {
  parseStoredEvidence,
  parseStoredValidationGaps,
} from "../features/memory/evidence";
import { normalizeCertaintyValue, parseTags, stringValue } from "../shared";
import { renderPretty } from "./pretty";

export const prettyOutput = GlobalFlag.Setting("pretty")({
  flag: Flag.Boolean("pretty").pipe(
    Flag.withDescription("Render human-readable output for machine commands"),
    Flag.withDefault(false),
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
  const strength = stringValue(row.match_strength);
  const match = strength ? ` <match:${strength}>` : "";
  const evidence = parseStoredEvidence(row.evidence);
  const gaps = parseStoredValidationGaps(row.validation_gaps).length;
  const support = `${evidence.length > 0 ? ` <evidence:${evidence.join("+")}>` : ""}${gaps > 0 ? ` <gaps:${gaps}>` : ""}`;
  const content = stringValue(row.content).replace(/\s+/g, " ").trim();
  return `[${id}] <${certainty}>${support} <${type}>${match}: ${content} ${briefTagText(row.tags)}`;
}

const SNIPPET_MAX_CHARS = 140;

/** Content head for triage in minimal output, so relevance can be judged without a full get. */
export function contentSnippet(content: JsonValue | undefined): string {
  const flattened = stringValue(content).replace(/\s+/g, " ").trim();
  return flattened.length > SNIPPET_MAX_CHARS
    ? `${flattened.slice(0, SNIPPET_MAX_CHARS - 1)}…`
    : flattened;
}

export function printBriefLines(rows: JsonObject[]) {
  console.info(rows.map(formatBriefMemoryLine).join("\n"));
}

/** Compact evidence fields: kinds when known, and how many gaps are recorded. */
export function evidenceSummary(row: JsonObject): JsonObject {
  const summary: JsonObject = {};
  const evidence = parseStoredEvidence(row.evidence);
  const gaps = parseStoredValidationGaps(row.validation_gaps).length;
  if (evidence.length > 0) {
    summary.evidence = evidence;
  }
  if (gaps > 0) {
    summary.validation_gap_count = gaps;
  }
  return summary;
}

export function minimalResultSummary(row: JsonObject): JsonObject {
  const summary: JsonObject = {
    id: Number(row.id ?? 0),
    score: Number(row.score ?? 0),
    memory_type: stringValue(row.memory_type, "convention"),
    certainty: normalizeCertaintyValue(row.certainty),
    tags: parseTags(stringValue(row.tags)),
  };
  Object.assign(summary, evidenceSummary(row));
  const strength = stringValue(row.match_strength);
  if (strength) {
    summary.match_strength = strength;
  }
  if (Array.isArray(row.exact_matches) && row.exact_matches.length > 0) {
    summary.exact_matches = row.exact_matches;
  }
  summary.snippet = contentSnippet(row.content);
  return summary;
}

export function queryEmptyResultPayload(
  term: string,
  filters: CommonFilters,
  queryTokens: string[],
) {
  return {
    results: [],
    no_strong_match: true,
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

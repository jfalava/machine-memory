import { Flag, GlobalFlag } from "effect/cli";

import { asciiSafe, type CommandFlags, printJson } from "../../cli-utils";
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
  pretty: boolean;
  quiet: boolean;
};

export function parseOutputMode(
  flags: CommandFlags,
  pretty = false,
): OutputMode {
  return {
    brief: flags.has("--brief"),
    jsonMin: flags.has("--json-min"),
    pretty,
    quiet: flags.has("--quiet"),
  };
}

export function prettyOutputEnabled(mode: OutputMode): boolean {
  return mode.pretty && !mode.brief && !mode.jsonMin && !mode.quiet;
}

export function outputModeForPretty(pretty: boolean): OutputMode {
  return parseOutputMode(new Map(), pretty);
}

export function printCommandOutput(
  context: { command: string; outputMode: OutputMode },
  data: JsonValue,
) {
  if (prettyOutputEnabled(context.outputMode)) {
    console.info(asciiSafe(renderPretty(context.command, data)));
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
export function contentSnippet(
  content: JsonValue | undefined,
  maxChars = SNIPPET_MAX_CHARS,
): string {
  const flattened = stringValue(content).replace(/\s+/g, " ").trim();
  return flattened.length > maxChars
    ? `${flattened.slice(0, maxChars - 1)}…`
    : flattened;
}

export function printBriefLines(rows: JsonObject[]) {
  console.info(asciiSafe(rows.map(formatBriefMemoryLine).join("\n")));
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

/**
 * One result of a read in --json-min: what it is and a snippet for triage.
 * Scored reads also carry the score and how well the result matched.
 */
export function minimalResultSummary(row: JsonObject): JsonObject {
  const summary: JsonObject = { id: Number(row.id ?? 0) };
  if (row.score !== undefined) {
    summary.score = Number(row.score);
  }
  Object.assign(summary, {
    memory_type: stringValue(row.memory_type, "convention"),
    certainty: normalizeCertaintyValue(row.certainty),
    status: stringValue(row.status, "active"),
    tags: parseTags(stringValue(row.tags)),
    ...evidenceSummary(row),
  });
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

/**
 * The one shape every read prints as JSON: `repository` (and `warning`),
 * `count`, command-specific fields, then `results`. The output mode only
 * changes how much each result carries: the whole memory, a summary in
 * --json-min, or the id alone in --quiet.
 */
export function readEnvelope(
  mode: OutputMode,
  scope: JsonObject,
  rows: JsonObject[],
  options: {
    extras?: JsonObject;
    summarize?: (row: JsonObject) => JsonObject;
  } = {},
): JsonObject {
  const summarize = options.summarize ?? minimalResultSummary;
  let results: JsonObject[] = rows;
  if (mode.quiet) {
    results = rows.map((row) => ({ id: Number(row.id ?? 0) }));
  } else if (mode.jsonMin) {
    results = rows.map(summarize);
  }
  return { ...scope, count: rows.length, ...options.extras, results };
}

/** Prints a read: one line per memory in --brief, the envelope otherwise. */
export function printRead(
  context: { command: string; outputMode: OutputMode },
  rows: JsonObject[],
  envelope: JsonObject,
) {
  if (context.outputMode.brief) {
    printBriefLines(rows);
    return;
  }
  printCommandOutput(context, envelope);
}

export function queryEmptyResultPayload(
  term: string,
  filters: CommonFilters,
  queryTokens: string[],
) {
  return {
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

import { normalizeCertaintyValue, parseTags, stringValue } from "../shared";
import type { CommonFilters } from "../../constants";

export type OutputMode = {
  brief: boolean;
  jsonMin: boolean;
  noConflicts: boolean;
  quiet: boolean;
};

export function parseOutputMode(args: string[]): OutputMode {
  return {
    brief: args.includes("--brief"),
    jsonMin: args.includes("--json-min"),
    noConflicts: args.includes("--no-conflicts"),
    quiet: args.includes("--quiet"),
  };
}

export function hasMinimalOutput(mode: OutputMode): boolean {
  return mode.brief || mode.jsonMin || mode.quiet;
}

function briefTagText(tags: unknown): string {
  const parsed = parseTags(stringValue(tags));
  return parsed.length === 0
    ? "(#none)"
    : `(${parsed.map((tag) => `#${tag}`).join(" ")})`;
}

function formatBriefMemoryLine(row: Record<string, unknown>): string {
  const id = Number(row.id ?? 0);
  const certainty = normalizeCertaintyValue(row.certainty);
  const type = stringValue(row.memory_type, "convention");
  const content = stringValue(row.content).replace(/\s+/g, " ").trim();
  return `[${id}] <${certainty}> <${type}>: ${content} ${briefTagText(row.tags)}`;
}

export function printBriefLines(rows: Record<string, unknown>[]) {
  console.info(rows.map(formatBriefMemoryLine).join("\n"));
}

export function minimalResultSummary(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: Number(row.id ?? 0),
    score: Number(row.score ?? 0),
    memory_type: stringValue(row.memory_type, "convention"),
    certainty: normalizeCertaintyValue(row.certainty),
    tags: parseTags(stringValue(row.tags)),
  };
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

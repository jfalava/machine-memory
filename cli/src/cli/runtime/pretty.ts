import pc from "picocolors";
import { getBorderCharacters, table as formatTable } from "table";
import {
  jsonBoolean,
  jsonNumber,
  jsonObject,
  jsonString,
  type JsonObject,
  type JsonValue,
} from "../../json";

const ANSI_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);
const MAX_CELL_WIDTH = 64;
const MAX_CONTENT_WIDTH = 96;
const MAX_TABLE_WIDTH = 160;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return jsonObject(value) !== undefined;
}

function visibleLength(value: string): number {
  return value.replace(ANSI_PATTERN, "").length;
}

function padRight(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value || "—";
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function compactScalar(value: JsonValue | undefined): string {
  const string = jsonString(value);
  if (string !== undefined) {
    return string;
  }
  const number = jsonNumber(value);
  if (number !== undefined) {
    return String(number);
  }
  const boolean = jsonBoolean(value);
  if (boolean !== undefined) {
    return String(boolean);
  }
  return "—";
}

function compact(
  value: JsonValue | undefined,
  maxLength = MAX_CELL_WIDTH,
): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (Array.isArray(value)) {
    const result = value.map((item) => compact(item, maxLength)).join(", ");
    return result || "—";
  }
  if (isObject(value)) {
    const result = Object.entries(value)
      .map(([key, item]) => `${key}=${compact(item, 32)}`)
      .join(", ");
    return result || "—";
  }
  return truncate(compactScalar(value).replace(/\s+/g, " ").trim(), maxLength);
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function wrapText(value: string, maxWidth: number): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  if (words.length === 1 && words[0] === "") {
    return [];
  }
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= maxWidth) {
      current += " " + word;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

function terminalTextWidth(indentLength: number): number {
  return Math.max(24, (process.stdout.columns ?? 100) - indentLength - 2);
}

function renderHelpText(indent: string, value: string): string[] {
  return wrapText(value, terminalTextWidth(indent.length)).map(
    (line) => indent + line,
  );
}

function renderHelpUsage(indent: string, usage: string): string[] {
  const prefix = indent + "  Usage: ";
  const continuation = indent + "         ";
  return wrapText(usage, terminalTextWidth(prefix.length)).map((line, index) =>
    index === 0 ? prefix + line : continuation + line,
  );
}

function renderHelpChildren(name: string, value: JsonObject): string[] {
  const childLines: string[] = [];
  for (const [childName, childValue] of Object.entries(value)) {
    if (childName === "usage" || childName === "description") {
      continue;
    }
    if (childLines.length > 0) {
      childLines.push("");
    }
    childLines.push(...renderHelpCommand(name + " " + childName, childValue));
  }
  return childLines;
}

function renderHelpCommand(
  name: string,
  value: JsonValue,
  indent = "  ",
): string[] {
  const lines = [indent + name];
  const string = jsonString(value);
  if (string !== undefined) {
    return lines.concat(renderHelpText(indent + "  ", string));
  }
  if (!isObject(value)) {
    return lines;
  }

  const usage = jsonString(value.usage);
  const description = jsonString(value.description);
  if (usage) {
    lines.push(...renderHelpUsage(indent, usage));
  }
  if (description) {
    lines.push(...renderHelpText(indent + "  ", description));
  }
  if (!usage && !description) {
    const childLines = renderHelpChildren(name, value);
    return childLines.length > 0 ? childLines : lines;
  }
  return lines;
}

function renderTable(
  headers: string[],
  rows: string[][],
  options: { maxWidth?: number } = {},
): string[] {
  if (rows.length === 0) {
    return [pc.dim("  No results.")];
  }

  const terminalWidth = process.stdout.columns ?? 100;
  const maxWidth = Math.min(
    options.maxWidth ?? terminalWidth - 2,
    terminalWidth - 2,
  );
  const borderAndPaddingWidth = headers.length * 2 + headers.length + 1;
  const availableCellWidth = Math.max(
    headers.length * 4,
    maxWidth - borderAndPaddingWidth,
  );
  const identityWidth = Math.min(
    6 + 12 + 12,
    availableCellWidth - headers.length * 4,
  );
  const remainingWidth = Math.max(8, availableCellWidth - identityWidth);
  const tagsWidth = Math.max(
    8,
    Math.min(26, Math.floor(remainingWidth * 0.35)),
  );
  const contentWidth = Math.max(8, remainingWidth - tagsWidth);
  const widths = [6, 12, 12, tagsWidth, contentWidth];
  const columnWidths =
    headers.length === 5
      ? widths.map((width) => Math.max(4, width))
      : headers.map(() =>
          Math.max(8, Math.floor(availableCellWidth / headers.length)),
        );
  const data = [
    headers.map((header) => pc.bold(header)),
    ...rows.map((row) =>
      headers.map((_, index) => compact(row[index] ?? "", MAX_CONTENT_WIDTH)),
    ),
  ];
  return formatTable(data, {
    border: getBorderCharacters("norc"),
    columns: columnWidths.map((width) => ({
      width,
      wrapWord: true,
      verticalAlignment: "top",
    })),
    drawHorizontalLine: () => true,
  })
    .split("\n")
    .map((line) => `  ${line}`);
}

function renderKeyValues(values: JsonObject): string[] {
  const entries = Object.entries(values).filter(
    ([, value]) => !Array.isArray(value) && !isObject(value),
  );
  if (entries.length === 0) {
    return [];
  }
  const width = Math.max(...entries.map(([key]) => key.length));
  return entries.map(
    ([key, value]) =>
      `  ${pc.dim(padRight(titleCase(key), width))}  ${compact(value, 160)}`,
  );
}

function memoryRows(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isObject);
}

function renderMemoryTable(rows: JsonObject[], heading: string): string[] {
  const lines = [
    pc.bold(heading),
    pc.dim(`  ${rows.length} ${rows.length === 1 ? "memory" : "memories"}`),
    "",
  ];
  lines.push(
    ...renderTable(
      ["ID", "TYPE", "CERTAINTY", "TAGS", "CONTENT"],
      rows.map((row) => [
        compact(row.id),
        compact(row.memory_type),
        compact(row.certainty),
        compact(row.tags),
        compact(row.content, MAX_CONTENT_WIDTH),
      ]),
      { maxWidth: MAX_TABLE_WIDTH },
    ),
  );
  return lines;
}

function renderMemoryDetail(row: JsonObject): string[] {
  const lines = [pc.bold(`Memory #${compact(row.id)}`), ""];
  const preferredKeys = [
    "content",
    "memory_type",
    "certainty",
    "status",
    "tags",
    "context",
    "repository",
    "created_at",
    "updated_at",
    "source_agent",
    "last_updated_by",
    "update_count",
    "refs",
    "expires_after_days",
    "superseded_by",
  ];
  const present = Object.fromEntries(
    preferredKeys
      .filter((key) => Object.hasOwn(row, key))
      .map((key) => [key, row[key]]),
  );
  const scalarLines = renderKeyValues(present);
  if (scalarLines.length > 0) {
    lines.push(...scalarLines);
  }
  for (const [key, value] of Object.entries(present)) {
    if (!Array.isArray(value) && !isObject(value)) {
      continue;
    }
    lines.push("", pc.dim(titleCase(key)));
    if (Array.isArray(value)) {
      lines.push(
        ...(value.length === 0
          ? [pc.dim("  None")]
          : value.map((item) => `  • ${compact(item, 160)}`)),
      );
    } else {
      lines.push(...renderKeyValues(value));
    }
  }
  return lines;
}

function renderSearch(command: string, value: JsonValue): string[] {
  const payload = isObject(value) ? value : undefined;
  const rows = payload ? memoryRows(payload.results) : memoryRows(value);
  const heading =
    command === "query"
      ? `Search results${payload?.search_term ? ` for “${compact(payload.search_term, 80)}”` : ""}`
      : `${titleCase(command)} results`;
  const lines = renderMemoryTable(rows, heading);
  const metadata = payload
    ? Object.fromEntries(
        Object.entries(payload).filter(
          ([key, item]) =>
            !["results", "score_weights", "neighborhood"].includes(key) &&
            !Array.isArray(item) &&
            !isObject(item),
        ),
      )
    : {};
  const metadataLines = renderKeyValues(metadata);
  if (metadataLines.length > 0) {
    lines.splice(1, 0, ...metadataLines, "");
  }
  if (payload?.score_weights && isObject(payload.score_weights)) {
    lines.push(
      "",
      pc.dim("Score weights"),
      ...renderKeyValues(payload.score_weights),
    );
  }
  return lines;
}

function renderDoctor(value: JsonObject): string[] {
  const summary = isObject(value.summary) ? value.summary : {};
  const findingEntries = isObject(value.findings)
    ? Object.entries(value.findings).filter(([, item]) => Array.isArray(item))
    : [];
  const total = findingEntries.reduce(
    (count, [, items]) => count + (Array.isArray(items) ? items.length : 0),
    0,
  );
  const lines = [
    pc.bold("Memory doctor"),
    "",
    `  ${total} finding${total === 1 ? "" : "s"}`,
  ];
  const summaryLines = renderKeyValues(summary);
  if (summaryLines.length > 0) {
    lines.push("", ...summaryLines);
  }
  for (const [kind, items] of findingEntries) {
    if (!Array.isArray(items) || items.length === 0) {
      continue;
    }
    lines.push("", pc.dim(titleCase(kind)));
    lines.push(
      ...renderTable(
        ["ID", "DETAIL", "SUGGESTED COMMAND"],
        items
          .filter(isObject)
          .map((item) => [
            compact(item.id ?? item.keep_id ?? item.stale_id),
            compact(
              item.content ?? item.kind ?? item.reason ?? item.thread_key,
            ),
            compact(item.suggested_command, 120),
          ]),
        { maxWidth: 120 },
      ),
    );
  }
  const suggested = Array.isArray(value.suggested_commands)
    ? value.suggested_commands
    : [];
  if (suggested.length > 0) {
    lines.push(
      "",
      pc.dim("Suggested commands"),
      ...suggested.map((item) => `  • ${String(item)}`),
    );
  }
  return lines;
}

function renderStats(value: JsonObject): string[] {
  const lines = [pc.bold("Memory statistics"), "", ...renderKeyValues(value)];
  for (const key of [
    "breakdown_by_memory_type",
    "breakdown_by_certainty",
    "tag_frequency_map",
  ]) {
    const item = value[key];
    if (!isObject(item)) {
      continue;
    }
    lines.push("", pc.dim(titleCase(key)));
    lines.push(
      ...renderTable(
        ["VALUE", "COUNT"],
        Object.entries(item).map(([name, count]) => [name, compact(count)]),
      ),
    );
  }
  return lines;
}

function isMemoryResultArray(value: JsonValue[]): value is JsonObject[] {
  const rows = memoryRows(value);
  return (
    rows.length === value.length &&
    rows.some((row) => Object.hasOwn(row, "content"))
  );
}

function renderGenericArray(command: string, value: JsonValue[]): string[] {
  if (isMemoryResultArray(value)) {
    return renderMemoryTable(value, `${titleCase(command)} results`);
  }
  return [
    pc.bold(titleCase(command)),
    "",
    ...(value.length === 0
      ? [pc.dim("  No results.")]
      : value.map((item) => `  • ${compact(item, 160)}`)),
  ];
}

function renderGenericObjectArray(value: JsonValue[]): string[] {
  const rows = memoryRows(value);
  if (rows.length === value.length && rows.length > 0) {
    const fields = Object.keys(rows[0] ?? {}).slice(0, 5);
    return renderTable(
      fields,
      rows.map((row) => fields.map((field) => compact(row[field]))),
    );
  }
  return value.length === 0
    ? [pc.dim("  None")]
    : value.map((entry) => `  • ${compact(entry, 160)}`);
}

function renderGenericObject(command: string, value: JsonObject): string[] {
  const lines = [pc.bold(titleCase(command)), "", ...renderKeyValues(value)];
  for (const [key, item] of Object.entries(value)) {
    if (!Array.isArray(item) && !isObject(item)) {
      continue;
    }
    lines.push("", pc.dim(titleCase(key)));
    lines.push(
      ...(Array.isArray(item)
        ? renderGenericObjectArray(item)
        : renderKeyValues(item)),
    );
  }
  return lines;
}

function renderGeneric(command: string, value: JsonValue): string[] {
  if (Array.isArray(value)) {
    return renderGenericArray(command, value);
  }
  if (isObject(value)) {
    return renderGenericObject(command, value);
  }
  return [pc.bold(titleCase(command)), "", `  ${compact(value, 160)}`];
}

function renderHelpCommands(commands: JsonObject): string[] {
  const lines = [pc.dim("Commands")];
  Object.entries(commands).forEach(([command, item], index) => {
    if (index > 0) {
      lines.push("");
    }
    lines.push(...renderHelpCommand(command, item));
  });
  return lines;
}

function renderHelpOptions(globalOptions: JsonObject): string[] {
  const lines = [pc.dim("Global options")];
  for (const [option, description] of Object.entries(globalOptions)) {
    lines.push("  --" + option);
    lines.push(...renderHelpText("    ", compactScalar(description)));
  }
  return lines;
}

function renderHelp(value: JsonObject): string[] {
  const commands = isObject(value.commands) ? value.commands : {};
  const globalOptions = isObject(value.global_options)
    ? value.global_options
    : {};
  const name = jsonString(value.name) ?? "machine-memory";
  const description = jsonString(value.description);
  const database = jsonString(value.database);
  const lines = [pc.bold(name)];
  if (description) {
    lines.push("", ...renderHelpText("  ", description));
  }
  if (database) {
    lines.push("", pc.dim("Database"), ...renderHelpText("  ", database));
  }
  if (Object.keys(commands).length > 0) {
    lines.push("", ...renderHelpCommands(commands));
  }
  if (Object.keys(globalOptions).length > 0) {
    lines.push("", ...renderHelpOptions(globalOptions));
  }
  lines.push(
    "",
    pc.dim("Use --pretty for human-readable machine-command output."),
  );
  return lines;
}

function renderGet(value: JsonValue): string[] {
  if (isObject(value) && Array.isArray(value.results)) {
    const lines = renderMemoryTable(memoryRows(value.results), "Memories");
    if (Array.isArray(value.missing_ids) && value.missing_ids.length > 0) {
      lines.push("", `  Missing IDs  ${value.missing_ids.join(", ")}`);
    }
    return lines;
  }
  return isObject(value) && Object.hasOwn(value, "content")
    ? renderMemoryDetail(value)
    : renderGeneric("get", value);
}

function renderVersion(value: JsonValue): string[] | undefined {
  return isObject(value) && Object.hasOwn(value, "version")
    ? [pc.bold("machine-memory"), `  Version  ${compact(value.version)}`]
    : undefined;
}

function renderObjectWith(
  renderer: (value: JsonObject) => string[],
  value: JsonValue,
): string[] | undefined {
  return isObject(value) ? renderer(value) : undefined;
}

const specializedRenderers = new Map<
  string,
  (value: JsonValue) => string[] | undefined
>([
  ["version", renderVersion],
  ["help", (value) => renderObjectWith(renderHelp, value)],
  ["query", (value) => renderSearch("query", value)],
  ["list", (value) => renderSearch("list", value)],
  ["suggest", (value) => renderSearch("suggest", value)],
  ["sweep", (value) => renderSearch("sweep", value)],
  ["get", renderGet],
  [
    "export",
    (value) => renderMemoryTable(memoryRows(value), "Exported memories"),
  ],
  ["doctor", (value) => renderObjectWith(renderDoctor, value)],
  ["stats", (value) => renderObjectWith(renderStats, value)],
]);

function renderSpecialized(
  command: string,
  value: JsonValue,
): string[] | undefined {
  return specializedRenderers.get(command)?.(value);
}

export function renderPretty(command: string, value: JsonValue): string {
  return (
    renderSpecialized(command, value) ?? renderGeneric(command, value)
  ).join("\n");
}

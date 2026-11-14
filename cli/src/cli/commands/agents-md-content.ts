import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";

const MEMORY_BLOCK_START = "<!-- machine-memory:start -->";
const MEMORY_BLOCK_END = "<!-- machine-memory:end -->";

/**
 * Version of the managed block's text. Raise it whenever the block changes, so
 * checkouts that still carry an older block are told to run `init` again. A
 * block without a version line predates versions and counts as 1.
 */
export const MEMORY_BLOCK_VERSION = 2;

export type AgentsMemoryBackend = "local" | "remote" | "mcp";

/** How one backend names each step of the workflow. */
type BlockTerms = {
  readonly intro: string;
  readonly scanFiles: string;
  readonly scanTopic: string;
  readonly read: string;
  readonly expiry: string;
  readonly size: string;
  readonly update: string;
  readonly add: string;
  readonly lossReport: string;
  readonly evidence: string;
  readonly checkpoint: string;
};

function cliTerms(flag: "--local" | "--remote"): BlockTerms {
  return {
    intro: `This repository keeps durable project knowledge in \`machine-memory\`, in ${
      flag === "--remote"
        ? "a remote database shared by every checkout"
        : "the local SQLite database `machine-memory.db`"
    }. Every database command takes \`${flag}\`. \`machine-memory help workflow\` explains each step below in full.`,
    scanFiles: `\`machine-memory suggest --files "a.ts,b.ts" ${flag} --json-min\``,
    scanTopic: `\`machine-memory query "<topic>" ${flag === "--remote" ? "--hybrid " : ""}${flag} --json-min\``,
    read: `\`machine-memory get <id,id> ${flag}\``,
    expiry: "`--expires-after-days`",
    size: '`machine-memory size "<text>"`, or `--dry-run` on `add` and `update`',
    update: `\`machine-memory update <id> "<whole new content>" ${flag}\``,
    add: `\`machine-memory add "<content>" --upsert-match "<topic>" --type <type> ${flag}\``,
    lossReport:
      "`dropped` or `review_candidates` (also on stderr, in a `machine-memory:` line)",
    evidence: "`--certainty verified` requires `--evidence`",
    checkpoint: `run \`machine-memory checkpoint ${flag} --json-min\`, then`,
  };
}

const MCP_TERMS: BlockTerms = {
  intro:
    "This repository keeps durable project knowledge in `machine-memory`, reached through its MCP tools (`list_repositories` and `memory_*`); no CLI is needed. Every tool takes `repository`, the path of this checkout's origin remote, such as `owner/name`. Confirm it with `list_repositories` before the first write: a wrong slug reads as empty and writes to a new repository.",
  scanFiles: "`memory_suggest` with `{ repository, files }`",
  scanTopic: "`memory_query` with `{ repository, query }`",
  read: "`memory_get` for each id",
  expiry: "`expires_after_days`",
  size: "`memory_size` with the content, tags and context you intend to write",
  update: "`memory_update` (`id` and the whole new `content`)",
  add: "`memory_add` and `upsert_match`",
  lossReport: "`dropped` or `review_candidates`",
  evidence: "`certainty: verified` requires `evidence`",
  checkpoint:
    "list this task's writes with `memory_list` and the records for the touched files with `memory_suggest`, then",
};

export function agentsMdContent(backend: AgentsMemoryBackend): string {
  const terms =
    backend === "mcp"
      ? MCP_TERMS
      : cliTerms(backend === "remote" ? "--remote" : "--local");
  return [
    MEMORY_BLOCK_START,
    `<!-- machine-memory:version ${MEMORY_BLOCK_VERSION} ${backend} -->`,
    "## Project memory",
    "",
    terms.intro,
    "",
    `- Before changing code, scan once and read the records that bear on the task: ${terms.scanFiles} for known files, or ${terms.scanTopic} for a topic or a task that touches no files; then ${terms.read}. Results are candidates: judge them by \`match_strength\`, and "nothing relevant" is a valid outcome.`,
    "- When the user's instruction contradicts a stored record, follow the user and update the record.",
    `- Write one fact per record and start it with the command, path or identifier it is about. Store decisions, constraints, preferences, references and gotchas. Put delivery state in one \`status\` record with ${terms.expiry}. Leave out pixel values, UI state and deploy outcomes, and put facts about one machine in that machine's guidance file.`,
    `- Check size before writing: ${terms.size}. Content, tags and context share one 512-byte budget.`,
    `- Change a record with ${terms.update}. It replaces the content, so read the record first and keep the details that still hold. Create one with ${terms.add}, which updates a strong match instead of adding a duplicate.`,
    `- When a write reports ${terms.lossReport}, restore details dropped by mistake and update or deprecate the listed records.`,
    `- ${terms.evidence}: \`user_requirement\`, \`observed_implementation\`, \`verified_mechanism\` or \`tested_behavior\`. Reading the code proves only \`observed_implementation\`.`,
    "- When delegating, scan once and pass the record ids to child agents. Children return findings with their evidence; the parent writes them.",
    `- Before the final response, ${terms.checkpoint} add, update or deprecate records for what the task established.`,
    "",
    "Project preference: replace obsolete systems when practical; preserve backwards compatibility only when it is explicitly required.",
    MEMORY_BLOCK_END,
  ].join("\n");
}

const BLOCK_PATTERN = new RegExp(
  `${MEMORY_BLOCK_START}[\\s\\S]*?${MEMORY_BLOCK_END}`,
  "g",
);
const VERSION_LINE = /<!-- machine-memory:version (\d+) (local|remote|mcp) -->/;

/**
 * Stderr text when the managed block in `content` is older than this CLI
 * writes; undefined when it is current or `content` has no block.
 */
export function staleMemoryBlockWarning(content: string): string | undefined {
  const block = content.match(BLOCK_PATTERN)?.[0];
  if (block === undefined) {
    return undefined;
  }
  const versionLine = block.match(VERSION_LINE);
  const version = Number(versionLine?.[1] ?? 1);
  if (version >= MEMORY_BLOCK_VERSION) {
    return undefined;
  }
  const init =
    versionLine?.[2] === undefined
      ? "machine-memory init (--local|--remote|--mcp)"
      : `machine-memory init --${versionLine[2]}`;
  return `The machine-memory block in AGENTS.md is version ${version}; this CLI writes version ${MEMORY_BLOCK_VERSION}. Run '${init}' to replace it.`;
}

export function replaceMemoryBlock(
  content: string,
  backend: AgentsMemoryBackend,
): string {
  const managedContent = agentsMdContent(backend);
  if (content.search(BLOCK_PATTERN) >= 0) {
    return content.replace(BLOCK_PATTERN, managedContent);
  }
  return `${content.trimEnd()}${content.trim() ? "\n\n" : ""}${managedContent}\n`;
}

/** Reads the AGENTS.md at `path` (empty when missing) and writes it back with the managed block replaced. */
export function writeMemoryBlock(
  fileSystem: FileSystem,
  path: string,
  backend: AgentsMemoryBackend,
) {
  return Effect.gen(function* () {
    const existingContent = (yield* fileSystem.exists(path))
      ? new TextDecoder().decode(yield* fileSystem.readFile(path))
      : "";
    yield* fileSystem.writeFile(
      path,
      new TextEncoder().encode(replaceMemoryBlock(existingContent, backend)),
    );
  });
}

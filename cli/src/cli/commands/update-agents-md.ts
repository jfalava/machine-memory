import { Effect } from "effect";
import { resolve } from "node:path";
import { DB_PATH } from "../../constants";
import { loadDatabaseConfig } from "../../database-config";
import type { CommandContext } from "../runtime/context";
import { remoteProvision, remoteSetup } from "./remote";

const MEMORY_BLOCK_START = "<!-- machine-memory:start -->";
const MEMORY_BLOCK_END = "<!-- machine-memory:end -->";

const AGENTS_MD_CONTENT = [
  MEMORY_BLOCK_START,
  "## Project memory",
  "",
  "This project uses `machine-memory` with its database at `machine-memory.db`.",
  "On first setup, `machine-memory update-agents-md` can use local memory, connect an existing remote Worker, or provision the Alchemy D1 stack. Remote provisioning accepts `--stack-name`, `--database-name`, and `--api-name` through `machine-memory remote provision`.",
  "",
  "Before editing, run exactly one focused retrieval command from the repository root:",
  "",
  '- Known files: `machine-memory suggest --files "path/a.ts,path/b.ts" --json-min`',
  '- Known topic: `machine-memory query "topic" --json-min`',
  '- Broad audit: `machine-memory list --tags "area:..." --json-min`',
  "",
  "Fetch full records only when the result looks relevant: `machine-memory get <id>` or `machine-memory get <id,id,...>`.",
  "",
  "At task end, persist only durable decisions, constraints, preferences, and non-obvious gotchas. Update an existing canonical record when possible; do not store obvious code facts, routine test results, or temporary progress. Use status memories only for short-lived work and give them an expiry.",
  "",
  "Use exact file paths and put filenames, keys, routes, thresholds, and other retrieval anchors in the first sentence. Prefer path-based tags with `--path` and `tag-map`; use `--upsert-match` only after checking that the match is the intended canonical record.",
  "",
  "Run `machine-memory doctor` during maintenance, not every task. Ensure `machine-memory.db` is writable before memory writes.",
  MEMORY_BLOCK_END,
].join("\n");

function replaceMemoryBlock(content: string): string {
  const blockPattern = new RegExp(
    `${MEMORY_BLOCK_START}[\\s\\S]*?${MEMORY_BLOCK_END}`,
    "g",
  );
  if (blockPattern.test(content)) {
    return content.replace(blockPattern, AGENTS_MD_CONTENT);
  }
  const legacyStart = content.indexOf("# Project memory");
  if (legacyStart === 0) {
    const prefix = content.slice(0, legacyStart).trimEnd();
    return (prefix ? prefix.concat("\n\n") : "").concat(
      AGENTS_MD_CONTENT,
      "\n",
    );
  }
  return `${content.trimEnd()}${content.trim() ? "\n\n" : ""}${AGENTS_MD_CONTENT}\n`;
}

export function handleUpdateAgentsMdCommand(commandCtx: CommandContext) {
  const agentsMdPath = resolve(process.cwd(), "AGENTS.md");
  return Effect.gen(function* () {
    const agentsExists = yield* commandCtx.fileSystem.exists(agentsMdPath);
    yield* offerFirstRunSetup(commandCtx, agentsExists);
    const existingContent = agentsExists
      ? new TextDecoder().decode(
          yield* commandCtx.fileSystem.readFile(agentsMdPath),
        )
      : "";
    yield* commandCtx.fileSystem.writeFile(
      agentsMdPath,
      new TextEncoder().encode(replaceMemoryBlock(existingContent)),
    );
    yield* Effect.sync(() =>
      console.info(
        "Updated AGENTS.md with recommendations on machine-memory usage",
      ),
    );
  });
}

function offerFirstRunSetup(
  commandCtx: CommandContext,
  agentsExists: boolean,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (agentsExists || (yield* commandCtx.fileSystem.exists(DB_PATH))) {
      return;
    }

    const configured = yield* Effect.tryPromise({
      try: () => loadDatabaseConfig(),
      catch: (cause) => cause,
    });
    if (configured.kind === "remote") {
      return;
    }

    const choice = yield* Effect.sync(() => {
      const answer = globalThis.prompt(
        "No memory backend is configured. Choose local, remote, create, or skip [local]:",
      );
      return (answer?.trim().toLowerCase() || "local") as
        | "local"
        | "remote"
        | "create"
        | "skip";
    });
    if (choice === "remote") {
      yield* remoteSetup(commandCtx);
    } else if (choice === "create") {
      yield* remoteProvision(commandCtx);
    } else if (choice !== "local" && choice !== "skip") {
      yield* Effect.fail(
        new Error("Choose local, remote, create, or skip during first-run setup."),
      );
    }
  });
}

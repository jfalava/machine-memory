import { Effect } from "effect";
import { resolve } from "node:path";
import { DB_PATH } from "../../constants";
import {
  databaseConfig,
  loadStoredRemoteCredentials,
  validateDatabaseBackendFlags,
  type DatabaseBackendFlags,
} from "../../database-config";
import type { CommandContext } from "../runtime/context";
import { remoteProvision, remoteSetup } from "./remote";
import {
  replaceMemoryBlock,
  type AgentsMemoryBackend,
} from "./agents-md-content";

export function handleUpdateAgentsMdCommand(commandCtx: CommandContext) {
  const agentsMdPath = resolve(process.cwd(), "AGENTS.md");
  return Effect.gen(function* () {
    const backendFlags: DatabaseBackendFlags = {
      local: commandCtx.args.includes("--local"),
      remote: commandCtx.args.includes("--remote"),
    };
    yield* Effect.try({
      try: () => validateDatabaseBackendFlags(backendFlags, true),
      catch: (cause) => cause,
    });
    const agentsExists = yield* commandCtx.fileSystem.exists(agentsMdPath);
    yield* offerFirstRunSetup(commandCtx, agentsExists, backendFlags);
    const backend: AgentsMemoryBackend = backendFlags.remote
      ? "remote"
      : "local";
    const existingContent = agentsExists
      ? new TextDecoder().decode(
          yield* commandCtx.fileSystem.readFile(agentsMdPath),
        )
      : "";
    yield* commandCtx.fileSystem.writeFile(
      agentsMdPath,
      new TextEncoder().encode(replaceMemoryBlock(existingContent, backend)),
    );
    yield* Effect.sync(() =>
      console.info(
        `Updated AGENTS.md with ${backend} machine-memory recommendations`,
      ),
    );
  });
}

function offerFirstRunSetup(
  commandCtx: CommandContext,
  agentsExists: boolean,
  backendFlags: DatabaseBackendFlags,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (
      agentsExists ||
      backendFlags.local ||
      (yield* commandCtx.fileSystem.exists(DB_PATH))
    ) {
      return;
    }

    const configured = databaseConfig();
    if (configured.kind === "remote") {
      return;
    }
    const stored = yield* Effect.tryPromise({
      try: () => loadStoredRemoteCredentials(),
      catch: () => undefined,
    });
    if (stored) {
      return;
    }

    const choice = yield* Effect.sync(() => {
      const answer = globalThis.prompt(
        "No remote memory is configured. Choose setup, create, or skip [setup]:",
      );
      return (answer?.trim().toLowerCase() || "setup") as
        | "setup"
        | "create"
        | "skip";
    });
    if (choice === "setup") {
      yield* remoteSetup(commandCtx);
    } else if (choice === "create") {
      yield* remoteProvision(commandCtx);
    } else if (choice !== "skip") {
      yield* Effect.fail(
        new Error("Choose setup, create, or skip during first-run setup."),
      );
    }
  });
}

import { Effect } from "effect";
import pc from "picocolors";
import { relative, resolve } from "node:path";
import { DB_PATH } from "../../constants";
import {
  databaseConfig,
  loadStoredRemoteCredentials,
  validateDatabaseBackendFlags,
  type DatabaseBackendFlags,
} from "../../database-config";
import type { CommandContext } from "../runtime/context";
import { CommandError } from "../../effect/errors";
import { remoteProvision, remoteSetup } from "./remote";
import {
  replaceMemoryBlock,
  type AgentsMemoryBackend,
} from "./agents-md-content";

export function handleInitCommand(commandCtx: CommandContext) {
  const agentsMdPath = resolve(process.cwd(), "AGENTS.md");
  return Effect.gen(function* () {
    const backendFlags: DatabaseBackendFlags = {
      local: commandCtx.args.includes("--local"),
      remote: commandCtx.args.includes("--remote"),
    };
    yield* Effect.try({
      try: () => validateDatabaseBackendFlags(backendFlags, true),
      catch: (cause) =>
        new CommandError({
          message:
            cause instanceof Error
              ? cause.message
              : "Choose a database backend explicitly with --local or --remote.",
          command: "init",
          cause,
        }),
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
    yield* Effect.sync(() => {
      const action = agentsExists ? "Updated" : "Created";
      const backendFlag = `--${backend}`;
      const displayPath = relative(process.cwd(), agentsMdPath) || "AGENTS.md";
      console.info();
      console.info(pc.green(pc.bold(`✓ ${action} ${displayPath}`)));
      console.info(
        `${pc.dim("Backend")}  ${pc.cyan(backend)} ${pc.dim(`(${backendFlag} required on memory commands)`)}`,
      );
      console.info(
        `${pc.dim("Next")}     ${pc.bold(`machine-memory list ${backendFlag}`)}`,
      );
      console.info();
    });
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
      // SAFETY: unrecognized answers hit the else branch below, which fails loudly.
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

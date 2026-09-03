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
    const backend = yield* resolveInitBackend(commandCtx.args);
    const agentsExists = yield* commandCtx.fileSystem.exists(agentsMdPath);
    if (backend === "remote" || backend === "local") {
      const backendFlags: DatabaseBackendFlags = {
        local: backend === "local",
        remote: backend === "remote",
      };
      yield* offerFirstRunSetup(commandCtx, agentsExists, backendFlags);
    }
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
      const displayPath = relative(process.cwd(), agentsMdPath) || "AGENTS.md";
      console.info();
      console.info(pc.green(pc.bold(`✓ ${action} ${displayPath}`)));
      console.info(
        `${pc.dim("Backend")}  ${pc.cyan(backend)}${
          backend === "mcp"
            ? pc.dim(" (MCP tools; no CLI backend flag)")
            : pc.dim(` (--${backend} required on memory commands)`)
        }`,
      );
      if (backend === "mcp") {
        console.info(
          `${pc.dim("Next")}     connect an MCP client to your Worker ${pc.bold("/mcp")} endpoint, then ${pc.bold("list_repositories")}`,
        );
        console.info(
          `${pc.dim("Script")}   ${pc.bold("curl -fsSL https://machine-memory.jfa.dev/init-mcp | bash")}`,
        );
        console.info(
          `${pc.dim("Script")}   ${pc.bold("irm https://machine-memory.jfa.dev/init-mcp.ps1 | iex")} ${pc.dim("(Windows PowerShell)")}`,
        );
      } else {
        console.info(
          `${pc.dim("Next")}     ${pc.bold(`machine-memory list --${backend}`)}`,
        );
      }
      console.info();
    });
  });
}

function resolveInitBackend(
  args: readonly string[],
): Effect.Effect<AgentsMemoryBackend, CommandError> {
  return Effect.gen(function* () {
    const local = args.includes("--local");
    const remote = args.includes("--remote");
    const mcp = args.includes("--mcp");
    const selected = [local, remote, mcp].filter(Boolean).length;
    if (selected !== 1) {
      return yield* Effect.fail(
        new CommandError({
          message:
            "Choose exactly one init target: --local, --remote, or --mcp.",
          command: "init",
          cause: undefined,
        }),
      );
    }
    if (mcp) {
      return "mcp";
    }
    const backendFlags: DatabaseBackendFlags = { local, remote };
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
    return remote ? "remote" : "local";
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

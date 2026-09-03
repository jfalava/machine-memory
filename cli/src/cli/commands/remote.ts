import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { getFlagValue } from "../../cli-utils";
import {
  databaseConfig,
  loadStoredRemoteCredentials,
  normalizeRemoteUrl,
  saveRemoteCredentials,
} from "../../database-config";
import { CommandError } from "../../effect/errors";
import type { CommandContext } from "../runtime/context";
import {
  booleanFlag,
  booleanSpec,
  effectCommand,
  positionalArgs,
  stringFlag,
  stringSpec,
} from "../runtime/command";
import {
  deployConfigToEnv,
  loadDeployConfig,
  type DeployConfig,
} from "../../../../remote-db/cloudflare/src/deploy-config";


function commandError(
  message: string,
  cause?: unknown,
  command = "remote setup",
): CommandError {
  return new CommandError({ message, command, cause });
}

function ask(label: string, fallback: string | undefined): string {
  const suffix =
    fallback !== undefined
      ? ` ${pc.dim("[")}${pc.dim(fallback)}${pc.dim("]")}`
      : "";
  const answer = globalThis.prompt(`${pc.cyan(label)}${suffix}:`);
  const value = answer?.trim() || fallback;
  if (!value) {
    throw commandError(`${label} is required.`);
  }
  return value;
}

async function askMasked(label: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  // Piped input is not echoed by a terminal. Keep the existing prompt as a
  // fallback for runtimes that do not expose raw terminal input.
  if (!stdin.isTTY || !stdout.isTTY || stdin.setRawMode === undefined) {
    return ask(label, undefined);
  }

  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(`${pc.cyan(label)}: `);

  return readMaskedInput(stdin, stdout, wasRaw, label);
}

type MaskedInputState = {
  value: string;
  inEscapeSequence: boolean;
};

type MaskedCharacterAction = "continue" | "submit" | "cancel";

function handleMaskedCharacter(
  character: string,
  state: MaskedInputState,
  stdout: NodeJS.WriteStream,
): MaskedCharacterAction {
  if (state.inEscapeSequence) {
    // Ignore terminal cursor/navigation sequences pasted or typed into the
    // prompt instead of treating them as part of the token.
    if (/[A-Za-z~]/.test(character)) {
      state.inEscapeSequence = false;
    }
    return "continue";
  }
  if (character === "\u001b") {
    state.inEscapeSequence = true;
    return "continue";
  }
  if (character === "\r" || character === "\n") {
    return "submit";
  }
  if (character === "\u0003" || character === "\u0004") {
    return "cancel";
  }
  if (character === "\u0008" || character === "\u007f") {
    return handleMaskedBackspace(state, stdout);
  }
  if (character.charCodeAt(0) < 32) {
    return "continue";
  }
  state.value += character;
  stdout.write("*");
  return "continue";
}

function handleMaskedBackspace(
  state: MaskedInputState,
  stdout: NodeJS.WriteStream,
): MaskedCharacterAction {
  const characters = Array.from(state.value);
  if (characters.length > 0) {
    characters.pop();
    state.value = characters.join("");
    stdout.write("\b \b");
  }
  return "continue";
}

function decodeMaskedChunk(
  chunk: Uint8Array | string,
  decoder: TextDecoder,
): string {
  return chunk instanceof Uint8Array
    ? decoder.decode(chunk, { stream: true })
    : chunk;
}

function readMaskedInput(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  wasRaw: boolean,
  label: string,
): Promise<string> {
  return new Promise<string>((resolveInput, reject) => {
    const state: MaskedInputState = { value: "", inEscapeSequence: false };
    const decoder = new TextDecoder();

    const onData = (chunk: Uint8Array | string) => {
      const input = decodeMaskedChunk(chunk, decoder);
      for (const character of input) {
        const action = handleMaskedCharacter(character, state, stdout);
        if (action === "submit") {
          restoreMaskedInput(stdin, onData, wasRaw);
          stdout.write("\n");
          resolveInput(state.value.trim());
          return;
        }
        if (action === "cancel") {
          cancelMaskedInput({ stdin, stdout, onData, wasRaw, label, reject });
          return;
        }
      }
    };

    stdin.on("data", onData);
  });
}

function restoreMaskedInput(
  stdin: NodeJS.ReadStream,
  onData: (chunk: Uint8Array | string) => void,
  wasRaw: boolean,
): void {
  stdin.off("data", onData);
  stdin.setRawMode(wasRaw);
  stdin.pause();
}

function cancelMaskedInput(options: {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  onData: (chunk: Uint8Array | string) => void;
  wasRaw: boolean;
  label: string;
  reject: (reason?: Error) => void;
}): void {
  restoreMaskedInput(options.stdin, options.onData, options.wasRaw);
  options.stdout.write("\n");
  options.reject(commandError(`${options.label} input was cancelled.`));
}


function loadCurrentRemote() {
  return Effect.tryPromise({
    try: async () => {
      const configured = databaseConfig();
      if (configured.kind === "remote") {
        return configured;
      }

      const stored = await loadStoredRemoteCredentials();
      return stored ? { kind: "remote" as const, ...stored } : configured;
    },
    catch: (cause) =>
      commandError("Could not read stored remote credentials.", cause),
  });
}

export function remoteSetup(context: CommandContext) {
  return Effect.gen(function* () {
    const current = yield* loadCurrentRemote();
    const currentRemote = current.kind === "remote" ? current : undefined;
    const urlInput =
      getFlagValue(context.args, "--url") ??
      currentRemote?.url ??
      ask("Worker URL", undefined);
    const url = yield* Effect.try({
      try: () => normalizeRemoteUrl(urlInput),
      catch: (cause) =>
        commandError(
          cause instanceof Error ? cause.message : "Invalid Worker URL.",
          cause,
          "remote setup",
        ),
    });

    const token =
      getFlagValue(context.args, "--token") ??
      (currentRemote?.token || undefined) ??
      (yield* Effect.promise(() => askMasked("Worker token")));
    if (!token) {
      return yield* Effect.fail(commandError("Worker token is required."));
    }

    yield* Effect.tryPromise({
      try: () =>
        saveRemoteCredentials({
          url,
          token,
          stackName: currentRemote?.stackName,
          databaseName: currentRemote?.databaseName,
          apiName: currentRemote?.apiName,
        }),
      catch: (cause) =>
        commandError(
          "Could not store credentials in the OS keychain. Set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKENin the repository root instead.",
          cause,
        ),
    });

    yield* Effect.sync(() => printRemoteSaved(url));
  });
}

function docsFlagOverride(args: string[]): boolean | undefined {
  const noDocs = args.includes("--no-docs");
  const forceDocs = args.includes("--docs");
  if (noDocs && forceDocs) {
    throw commandError(
      "Pass only one of --docs or --no-docs.",
      undefined,
      "remote provision",
    );
  }
  if (noDocs) {
    return false;
  }
  if (forceDocs) {
    return true;
  }
  return undefined;
}

// Field-wise flag/env/credential merge for provision naming.
// oxlint-disable-next-line complexity -- precedence matrix per field
function resolveProvisionConfig(
  args: string[],
  currentRemote:
    | { stackName?: string; databaseName?: string; apiName?: string }
    | undefined,
): DeployConfig {
  const domainFlag = getFlagValue(args, "--domain");
  const loaded = loadDeployConfig({
    configPath: getFlagValue(args, "--config"),
    overrides: {
      domain: domainFlag,
      docs: docsFlagOverride(args),
      stackName: getFlagValue(args, "--stack-name"),
      databaseName: getFlagValue(args, "--database-name"),
      vectorIndexName: getFlagValue(args, "--vector-index-name"),
      oauthKvName: getFlagValue(args, "--oauth-kv-name"),
      workers: {
        router: getFlagValue(args, "--router-name"),
        api: getFlagValue(args, "--api-name"),
        mcp: getFlagValue(args, "--mcp-name"),
        docs: getFlagValue(args, "--docs-name"),
      },
    },
  });
  const stackName =
    getFlagValue(args, "--stack-name") ??
    process.env["MACHINE_MEMORY_STACK_NAME"]?.trim() ??
    currentRemote?.stackName ??
    loaded.stackName;
  const databaseName =
    getFlagValue(args, "--database-name") ??
    process.env["MACHINE_MEMORY_DB_NAME"]?.trim() ??
    currentRemote?.databaseName ??
    loaded.databaseName;
  const apiName =
    getFlagValue(args, "--api-name") ??
    process.env["MACHINE_MEMORY_API_NAME"]?.trim() ??
    currentRemote?.apiName ??
    loaded.workers.api;
  return {
    ...loaded,
    stackName,
    databaseName,
    workers: { ...loaded.workers, api: apiName },
  };
}

function printProvisioned(url: string, resolved: DeployConfig): void {
  console.info();
  console.info(pc.green(pc.bold("✓ Remote database provisioned")));
  console.info(`${pc.dim("URL")}       ${pc.cyan(url)}`);
  console.info(`${pc.dim("Stack")}     ${resolved.stackName}`);
  console.info(`${pc.dim("Database")}  ${resolved.databaseName}`);
  console.info(`${pc.dim("Router")}    ${resolved.workers.router}`);
  console.info(`${pc.dim("API")}       ${resolved.workers.api}`);
  console.info(`${pc.dim("MCP")}       ${resolved.workers.mcp}`);
  console.info(
    resolved.docs
      ? `${pc.dim("Docs")}      ${resolved.workers.docs}`
      : `${pc.dim("Docs")}      ${pc.dim("skipped")}`,
  );
  if (resolved.domain) {
    console.info(`${pc.dim("Domain")}    ${resolved.domain}`);
  }
  if (resolved.configPath) {
    console.info(`${pc.dim("Config")}    ${resolved.configPath}`);
  }
  console.info(`${pc.dim("Token")}     ${pc.dim("stored in the OS keychain")}`);
  console.info();
}

export function remoteProvision(context: CommandContext) {
  return Effect.gen(function* () {
    const current = yield* loadCurrentRemote();
    const currentRemote = current.kind === "remote" ? current : undefined;
    const resolved = yield* Effect.try({
      try: () => resolveProvisionConfig(context.args, currentRemote),
      catch: (cause) =>
        cause instanceof CommandError
          ? cause
          : commandError(
              cause instanceof Error ? cause.message : "Invalid provision flags.",
              cause,
              "remote provision",
            ),
    });
    const workerToken =
      process.env["MACHINE_MEMORY_DB_TOKEN"]?.trim() ??
      randomBytes(32).toString("hex");

    const deployment = yield* Effect.tryPromise({
      try: () =>
        runAlchemyDeploy({
          deployConfig: resolved,
          workerToken,
        }),
      catch: (cause) =>
        commandError(
          cause instanceof Error
            ? cause.message
            : "Could not deploy the remote database.",
          cause,
          "remote provision",
        ),
    });
    const url = yield* Effect.try({
      try: () => normalizeRemoteUrl(deployment.url),
      catch: (cause) =>
        commandError(
          "Alchemy did not return a valid Worker URL.",
          cause,
          "remote provision",
        ),
    });

    yield* Effect.tryPromise({
      try: () =>
        saveRemoteCredentials({
          url,
          token: workerToken,
          stackName: resolved.stackName,
          databaseName: resolved.databaseName,
          apiName: resolved.workers.api,
        }),
      catch: (cause) =>
        commandError(
          "The remote database was deployed, but credentials could not be stored in the OS keychain. Set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKEN.",
          cause,
          "remote provision",
        ),
    });

    yield* Effect.sync(() => printProvisioned(url, resolved));
  });
}

function printRemoteSaved(url: string) {
  console.info();
  console.info(pc.green(pc.bold("✓ Remote Worker credentials saved")));
  console.info(`${pc.dim("URL")}   ${pc.cyan(url)}`);
  console.info(`${pc.dim("Token")} ${pc.dim("stored in the OS keychain")}`);
  console.info();
  console.info(
    `${pc.dim("Next")}   ${pc.bold("machine-memory list")} will use this Worker.`,
  );
}

function remoteStackDirectory(): string {
  const candidates = [
    process.env["MACHINE_MEMORY_REMOTE_DB_DIR"],
    resolve(process.cwd(), "remote-db", "cloudflare"),
    resolve(import.meta.dir, "../../../../remote-db/cloudflare"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const directory = candidates.find((candidate) =>
    existsSync(resolve(candidate, "alchemy.run.ts")),
  );
  if (!directory) {
    throw new Error(
      "The Alchemy remote stack is unavailable. Set MACHINE_MEMORY_REMOTE_DB_DIR to the remote-db/cloudflare stack directory.",
    );
  }
  return directory;
}

async function runAlchemyDeploy(options: {
  deployConfig: DeployConfig;
  workerToken: string;
}): Promise<{ url: string }> {
  const directory = remoteStackDirectory();
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const child = Bun.spawn(["bun", "run", "alchemy", "deploy", "--yes"], {
    cwd: directory,
    env: {
      ...environment,
      ...deployConfigToEnv(options.deployConfig),
      MACHINE_MEMORY_DB_TOKEN: options.workerToken,
    },
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const output = stripTerminalColors(`${stdout}\n${stderr}`);
  if (output.trim()) {
    console.info(output.trim());
  }
  if (exitCode !== 0) {
    throw new Error(`Alchemy deploy failed with exit code ${exitCode}.`);
  }
  const url =
    output.match(/\burl\s*[:=]\s*["']?(https?:\/\/[^\s"']+)/i)?.[1] ??
    output.match(/https?:\/\/[^\s"']+workers\.dev[^\s"']*/i)?.[0];
  if (!url) {
    throw new Error(
      "Alchemy deploy completed but did not report the Worker URL. Run `machine-memory remote provision` again or configure the Worker URL with `machine-memory remote setup`.",
    );
  }
  return { url };
}

function stripTerminalColors(value: string): string {
  const escape = String.fromCharCode(27);
  return ["0", "1", "2", "22", "31", "32", "33", "36", "39", "90"].reduce(
    (current, code) => current.replaceAll(`${escape}[${code}m`, ""),
    value,
  );
}

const remoteSetupCommand = effectCommand(
  "setup",
  {
    args: positionalArgs(),
    url: stringFlag("url"),
    token: stringFlag("token"),
  },
  [stringSpec("url"), stringSpec("token")],
  undefined,
  remoteSetup,
);

const remoteProvisionCommand = effectCommand(
  "provision",
  {
    args: positionalArgs(),
    config: stringFlag("config"),
    domain: stringFlag("domain"),
    docs: booleanFlag("docs"),
    "no-docs": booleanFlag("no-docs"),
    "stack-name": stringFlag("stack-name"),
    "database-name": stringFlag("database-name"),
    "api-name": stringFlag("api-name"),
    "router-name": stringFlag("router-name"),
    "mcp-name": stringFlag("mcp-name"),
    "docs-name": stringFlag("docs-name"),
    "vector-index-name": stringFlag("vector-index-name"),
    "oauth-kv-name": stringFlag("oauth-kv-name"),
  },
  [
    stringSpec("config"),
    stringSpec("domain"),
    booleanSpec("docs"),
    booleanSpec("no-docs"),
    stringSpec("stack-name"),
    stringSpec("database-name"),
    stringSpec("api-name"),
    stringSpec("router-name"),
    stringSpec("mcp-name"),
    stringSpec("docs-name"),
    stringSpec("vector-index-name"),
    stringSpec("oauth-kv-name"),
  ],
  undefined,
  remoteProvision,
);

export const remoteCommand = Command.make("remote", {}, () =>
  Effect.sync(() => {
    console.info(
      `${pc.bold("Usage:")} machine-memory remote <setup|provision>`,
    );
    console.info(
      `${pc.dim("Setup:")} machine-memory remote setup --url <worker-url> --token <worker-token>`,
    );
    console.info(
      `${pc.dim("Provision:")} machine-memory remote provision [--config <file>] [--domain <host>] [--no-docs] [--stack-name <name>] [--api-name <name>] …`,
    );
    console.info(
      `${pc.dim("Config:")} copy remote-db/cloudflare/machine-memory.deploy.example.json → machine-memory.deploy.json`,
    );
  }),
).pipe(Command.withSubcommands([remoteSetupCommand, remoteProvisionCommand]));

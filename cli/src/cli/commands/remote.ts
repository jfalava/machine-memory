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
  effectCommand,
  positionalArgs,
  stringFlag,
  stringSpec,
} from "../runtime/command";

const DEFAULT_STACK_NAME = "machine-memory-remote-db";
const DEFAULT_DATABASE_NAME = "machine-memory-db";
const DEFAULT_API_NAME = "machine-memory-api";

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

function configuredName(
  context: CommandContext,
  options: {
    flag: string;
    environment: string;
    label: string;
    fallback: string;
    current: string | undefined;
  },
): string {
  return (
    getFlagValue(context.args, options.flag) ??
    process.env[options.environment]?.trim() ??
    options.current ??
    ask(options.label, options.fallback)
  );
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

export function remoteProvision(context: CommandContext) {
  return Effect.gen(function* () {
    const current = yield* loadCurrentRemote();
    const currentRemote = current.kind === "remote" ? current : undefined;
    const stackName = configuredName(context, {
      flag: "--stack-name",
      environment: "MACHINE_MEMORY_STACK_NAME",
      label: "Alchemy stack name",
      fallback: DEFAULT_STACK_NAME,
      current: currentRemote?.stackName,
    });
    const databaseName = configuredName(context, {
      flag: "--database-name",
      environment: "MACHINE_MEMORY_DB_NAME",
      label: "D1 database name",
      fallback: DEFAULT_DATABASE_NAME,
      current: currentRemote?.databaseName,
    });
    const apiName = configuredName(context, {
      flag: "--api-name",
      environment: "MACHINE_MEMORY_API_NAME",
      label: "Worker API name",
      fallback: DEFAULT_API_NAME,
      current: currentRemote?.apiName,
    });
    const workerToken =
      process.env["MACHINE_MEMORY_DB_TOKEN"]?.trim() ??
      randomBytes(32).toString("hex");

    const deployment = yield* Effect.tryPromise({
      try: () =>
        runAlchemyDeploy({
          stackName,
          databaseName,
          apiName,
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
          stackName,
          databaseName,
          apiName,
        }),
      catch: (cause) =>
        commandError(
          "The remote database was deployed, but credentials could not be stored in the OS keychain. Set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKEN.",
          cause,
          "remote provision",
        ),
    });

    yield* Effect.sync(() => {
      console.info();
      console.info(pc.green(pc.bold("✓ Remote database provisioned")));
      console.info(`${pc.dim("URL")}       ${pc.cyan(url)}`);
      console.info(`${pc.dim("Stack")}     ${stackName}`);
      console.info(`${pc.dim("Database")}  ${databaseName}`);
      console.info(`${pc.dim("API")}       ${apiName}`);
      console.info(
        `${pc.dim("Token")}     ${pc.dim("stored in the OS keychain")}`,
      );
      console.info();
    });
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
  stackName: string;
  databaseName: string;
  apiName: string;
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
      MACHINE_MEMORY_STACK_NAME: options.stackName,
      MACHINE_MEMORY_DB_NAME: options.databaseName,
      MACHINE_MEMORY_API_NAME: options.apiName,
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
    "stack-name": stringFlag("stack-name"),
    "database-name": stringFlag("database-name"),
    "api-name": stringFlag("api-name"),
  },
  [
    stringSpec("stack-name"),
    stringSpec("database-name"),
    stringSpec("api-name"),
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
      `${pc.dim("Provision:")} machine-memory remote provision [--stack-name <name>] [--database-name <name>] [--api-name <name>]`,
    );
  }),
).pipe(Command.withSubcommands([remoteSetupCommand, remoteProvisionCommand]));

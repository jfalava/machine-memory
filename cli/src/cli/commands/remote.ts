import pc from "picocolors";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { getFlagValue } from "../../cli-utils";
import {
  loadDatabaseConfig,
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

function commandError(message: string, cause?: unknown): CommandError {
  return new CommandError({ message, command: "remote setup", cause });
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

function remoteSetup(context: CommandContext) {
  return Effect.gen(function* () {
    const current = yield* Effect.tryPromise({
      try: () => loadDatabaseConfig(),
      catch: (cause) =>
        commandError("Could not read stored credentials.", cause),
    });
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
        ),
    });

    const token =
      getFlagValue(context.args, "--token") ??
      (currentRemote?.token || undefined) ??
      ask("Worker token", undefined);
    if (!token) {
      return yield* Effect.fail(commandError("Worker token is required."));
    }

    yield* Effect.tryPromise({
      try: () => saveRemoteCredentials({ url, token }),
      catch: (cause) =>
        commandError("Could not store credentials in the OS keychain.", cause),
    });

    yield* Effect.sync(() => {
      console.info();
      console.info(pc.green(pc.bold("✓ Remote Worker credentials saved")));
      console.info(`${pc.dim("URL")}   ${pc.cyan(url)}`);
      console.info(`${pc.dim("Token")} ${pc.dim("stored in the OS keychain")}`);
      console.info();
      console.info(
        `${pc.dim("Next")}   ${pc.bold("machine-memory list")} will use this Worker.`,
      );
    });
  });
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

export const remoteCommand = Command.make("remote", {}, () =>
  Effect.sync(() => {
    console.info(`${pc.bold("Usage:")} machine-memory remote setup`);
    console.info(
      `${pc.dim("Options:")} --url <worker-url> --token <worker-token>`,
    );
  }),
).pipe(Command.withSubcommands([remoteSetupCommand]));

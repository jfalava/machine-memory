import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { CliError, CliOutput, Command } from "effect/unstable/cli";
import pc from "picocolors";
import { printJson } from "../cli-utils";
import { VERSION } from "../constants";
import { MemoryDatabaseError } from "../effect/database";
import { CommandError } from "../effect/errors";
import { UpgradeError } from "../upgrade";
import { builtinCommands, featureCommands } from "./commands/definitions";
import { helpPayload } from "./help";

const rootCommand = Command.make("machine-memory", {}, () =>
  Effect.gen(function* () {
    yield* Effect.sync(() => printJson(helpPayload()));
    return yield* Effect.fail(
      new CommandError({
        message: "A command is required. Run 'machine-memory help' for usage.",
        command: "machine-memory",
        cause: undefined,
      }),
    );
  }),
).pipe(Command.withSubcommands([...builtinCommands(), ...featureCommands]));

const knownCommands = new Set([
  "help",
  "version",
  "upgrade",
  ...featureCommands.map((command) => command.name),
]);

const formatter: CliOutput.Formatter = {
  formatHelpDoc: () => JSON.stringify(helpPayload()),
  formatVersion: (_name, version) => JSON.stringify({ version }),
  formatCliError: (error) => JSON.stringify({ error: error.message }),
  formatError: (error) => JSON.stringify({ error: error.message }),
  formatErrors: (errors) =>
    JSON.stringify({ error: errors.map((error) => error.message).join("\n") }),
};

const HUMAN_COMMANDS = new Set([
  "update-agents-md",
  "remote setup",
  "remote provision",
]);

function renderHumanCommandError(error: CommandError): void {
  console.error();
  console.error(pc.red(pc.bold(`✗ ${error.command} failed`)));
  console.error(`  ${String(error.message)}`);
  if (error.command === "update-agents-md") {
    console.error(
      `  ${pc.dim("Usage:")} machine-memory update-agents-md (--local|--remote)`,
    );
  } else if (error.command === "remote setup") {
    console.error(
      `  ${pc.dim("Next:")} machine-memory remote setup --url <worker-url> --token <worker-token>`,
    );
  } else if (error.command === "remote provision") {
    console.error(
      `  ${pc.dim("Next:")} machine-memory remote provision [--stack-name <name>] [--database-name <name>] [--api-name <name>]`,
    );
  }
  console.error();
}

function unknownCommand(args: ReadonlyArray<string>): string | undefined {
  const command = args[0];
  return command && !command.startsWith("-") && !knownCommands.has(command)
    ? command
    : undefined;
}

function renderError(error: unknown): void {
  if (CliError.isCliError(error) && error._tag === "ShowHelp") {
    return;
  }
  if (error instanceof UpgradeError) {
    printJson(error.payload);
    return;
  }
  if (error instanceof MemoryDatabaseError || error instanceof CommandError) {
    if (error instanceof CommandError && HUMAN_COMMANDS.has(error.command)) {
      renderHumanCommandError(error);
      return;
    }
    printJson({
      error: error.message,
      ...(error instanceof MemoryDatabaseError
        ? { operation: error.operation }
        : {}),
    });
    return;
  }
  printJson({
    error: error instanceof Error ? error.message : "Unexpected CLI failure.",
  });
}

export function runCli(args: ReadonlyArray<string>) {
  const command = unknownCommand(args);
  if (command) {
    return Effect.sync(() => {
      printJson({
        error: `Unknown command: ${command}. Run 'machine-memory help' for usage.`,
      });
      process.exitCode = 1;
    });
  }
  return Command.runWith(rootCommand, { version: VERSION })(args).pipe(
    Effect.provide(CliOutput.layer(formatter)),
    Effect.provide(BunServices.layer),
    Effect.catch((error) =>
      Effect.sync(() => {
        renderError(error);
        if (
          !(
            CliError.isCliError(error) &&
            error._tag === "ShowHelp" &&
            error.errors.length === 0
          )
        ) {
          process.exitCode = 1;
        }
      }),
    ),
  );
}

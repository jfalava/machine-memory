import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { CliError, CliOutput, Command } from "effect/unstable/cli";
import { printJson } from "../cli";
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

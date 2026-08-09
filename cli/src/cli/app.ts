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

const HUMAN_COMMANDS = new Set([
  "upgrade",
  "init",
  "remote setup",
  "remote provision",
]);

const formatter: CliOutput.Formatter = {
  formatHelpDoc: () => JSON.stringify(helpPayload()),
  formatVersion: (_name, version) => JSON.stringify({ version }),
  formatCliError: (error) => JSON.stringify({ error: error.message }),
  formatError: (error) => JSON.stringify({ error: error.message }),
  formatErrors: (errors) =>
    JSON.stringify({ error: errors.map((error) => error.message).join("\n") }),
};

function humanUpgradeErrorLines(message: string): string[] {
  return ["", pc.red(pc.bold("✗ Upgrade failed")), `  ${String(message)}`, ""];
}

function humanCommandErrorLines(error: CommandError): string[] {
  const lines = [
    "",
    pc.red(pc.bold(`✗ ${error.command} failed`)),
    `  ${String(error.message)}`,
  ];
  if (error.command === "init") {
    lines.push(`  ${pc.dim("Usage:")} machine-memory init (--local|--remote)`);
  } else if (error.command === "remote setup") {
    lines.push(
      `  ${pc.dim("Next:")} machine-memory remote setup --url <worker-url> --token <worker-token>`,
    );
  } else if (error.command === "remote provision") {
    lines.push(
      `  ${pc.dim("Next:")} machine-memory remote provision [--stack-name <name>] [--database-name <name>] [--api-name <name>]`,
    );
  }
  lines.push("");
  return lines;
}

function humanCommandHelp(command: string): string {
  switch (command) {
    case "upgrade":
      return "Usage: machine-memory upgrade";
    case "init":
      return "Usage: machine-memory init (--local|--remote)";
    case "remote setup":
      return "Usage: machine-memory remote setup [--url <worker-url>] [--token <worker-token>]";
    case "remote provision":
      return "Usage: machine-memory remote provision [--stack-name <name>] [--database-name <name>] [--api-name <name>]";
    default:
      return JSON.stringify(helpPayload());
  }
}

function formatterFor(command: string | undefined): CliOutput.Formatter {
  if (!command || !HUMAN_COMMANDS.has(command)) {
    return formatter;
  }
  return {
    formatHelpDoc: () => humanCommandHelp(command),
    formatVersion: formatter.formatVersion,
    formatCliError: formatter.formatCliError,
    formatError: formatter.formatError,
    formatErrors: (errors) =>
      command === "upgrade"
        ? humanUpgradeErrorLines(
            errors.map((error) => error.message).join("\n"),
          ).join("\n")
        : humanCommandErrorLines(
            new CommandError({
              command,
              message: errors.map((error) => error.message).join("\n"),
              cause: undefined,
            }),
          ).join("\n"),
  };
}

function renderHumanCommandError(error: CommandError): void {
  for (const line of humanCommandErrorLines(error)) {
    console.error(line);
  }
}

function renderHumanUpgradeError(error: UpgradeError): void {
  for (const line of humanUpgradeErrorLines(String(error.message))) {
    console.error(line);
  }
}

function renderHumanCommandFailure(command: string, error: unknown): void {
  if (command === "upgrade") {
    renderHumanUpgradeError(
      new UpgradeError({
        error:
          error instanceof Error ? error.message : "Unexpected CLI failure.",
      }),
    );
    return;
  }
  renderHumanCommandError(
    new CommandError({
      command,
      message:
        error instanceof Error ? error.message : "Unexpected CLI failure.",
      cause: undefined,
    }),
  );
}

function isReindexSummaryFailure(
  command: string | undefined,
  error: unknown,
): boolean {
  return (
    command === "reindex" &&
    error instanceof MemoryDatabaseError &&
    error.operation === "vectorize/reindex"
  );
}

function unknownCommand(args: ReadonlyArray<string>): string | undefined {
  const command = args[0];
  return command && !command.startsWith("-") && !knownCommands.has(command)
    ? command
    : undefined;
}

function commandPath(args: ReadonlyArray<string>): string | undefined {
  const first = args[0];
  const firstTwo = args.slice(0, 2).join(" ");
  return HUMAN_COMMANDS.has(firstTwo)
    ? firstTwo
    : first && HUMAN_COMMANDS.has(first)
      ? first
      : undefined;
}

function renderError(error: unknown, command: string | undefined): void {
  if (CliError.isCliError(error) && error._tag === "ShowHelp") {
    return;
  }
  if (isReindexSummaryFailure(command, error)) {
    return;
  }
  if (error instanceof UpgradeError) {
    renderHumanUpgradeError(error);
    return;
  }
  if (command && HUMAN_COMMANDS.has(command)) {
    renderHumanCommandFailure(command, error);
    return;
  }
  if (error instanceof MemoryDatabaseError) {
    printJson({
      error: error.message,
      operation: error.operation,
    });
    return;
  }
  if (error instanceof CommandError) {
    if (HUMAN_COMMANDS.has(error.command)) {
      renderHumanCommandError(error);
      return;
    }
    printJson({
      error: error.message,
    });
    return;
  }
  printJson({
    error: error instanceof Error ? error.message : "Unexpected CLI failure.",
  });
}

export function runCli(args: ReadonlyArray<string>) {
  const command = unknownCommand(args);
  const commandPathName = commandPath(args);
  const errorCommand =
    commandPathName ?? (args[0] === "reindex" ? "reindex" : undefined);
  if (command) {
    return Effect.sync(() => {
      printJson({
        error: `Unknown command: ${command}. Run 'machine-memory help' for usage.`,
      });
      process.exitCode = 1;
    });
  }
  return Command.runWith(rootCommand, { version: VERSION })(args).pipe(
    Effect.provide(CliOutput.layer(formatterFor(commandPathName))),
    Effect.provide(BunServices.layer),
    Effect.catch((error) =>
      Effect.sync(() => {
        renderError(error, errorCommand);
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

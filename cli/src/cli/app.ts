import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { CliError, CliOutput, Command } from "effect/unstable/cli";
import pc from "picocolors";
import {
  printCommandOutput,
  prettyOutput,
  outputModeForPretty,
} from "./runtime/output";
import { renderPretty } from "./runtime/pretty";
import { printJson } from "../cli-utils";
import { VERSION } from "../constants";
import { MemoryDatabaseError } from "../effect/database";
import { CommandError } from "../effect/errors";
import { UpgradeError } from "../upgrade";
import { builtinCommands, featureCommands } from "./commands/definitions";
import { helpPayload } from "./help";

const rootCommand = Command.make("machine-memory", {}, () =>
  Effect.gen(function* () {
    const pretty = yield* prettyOutput;
    yield* Effect.sync(() =>
      printCommandOutput(
        { command: "help", outputMode: outputModeForPretty(pretty) },
        helpPayload(),
      ),
    );
    return yield* Effect.fail(
      new CommandError({
        message: "A command is required. Run 'machine-memory help' for usage.",
        command: "machine-memory",
        cause: undefined,
      }),
    );
  }),
).pipe(
  Command.withSubcommands([...builtinCommands(), ...featureCommands]),
  Command.withGlobalFlags([prettyOutput]),
);

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
  "local export",
]);

const formatter: CliOutput.Formatter = {
  formatHelpDoc: () => JSON.stringify(helpPayload()),
  formatVersion: (_name, version) => JSON.stringify({ version }),
  formatCliError: (error) => JSON.stringify({ error: error.message }),
  formatError: (error) => JSON.stringify({ error: error.message }),
  formatErrors: (errors) =>
    JSON.stringify({ error: errors.map((error) => error.message).join("\n") }),
};

function prettyRequested(args: ReadonlyArray<string>): boolean {
  return args.some((arg) => arg === "--pretty" || arg === "--pretty=true");
}

function removePrettyFlag(args: ReadonlyArray<string>): string[] {
  return args.filter((arg) => arg !== "--pretty" && arg !== "--pretty=true");
}

function prettyErrorText(command: string, message: string): string {
  return ["", pc.red(pc.bold(`✗ ${command} failed`)), `  ${message}`, ""].join(
    "\n",
  );
}

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
  } else if (error.command === "local export") {
    lines.push(
      `  ${pc.dim("Usage:")} machine-memory local export [local-db-path] --remote`,
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
    case "local export":
      return "Usage: machine-memory local export [local-db-path] --remote";
    default:
      return JSON.stringify(helpPayload());
  }
}

function formatterFor(
  command: string | undefined,
  pretty: boolean,
): CliOutput.Formatter {
  if (!command || !HUMAN_COMMANDS.has(command)) {
    if (!pretty) {
      return formatter;
    }
    return {
      formatHelpDoc: () => renderPretty("help", helpPayload()),
      formatVersion: (_name, version) => `machine-memory v${version}`,
      formatCliError: (error) =>
        prettyErrorText(command ?? "machine-memory", error.message),
      formatError: (error) =>
        prettyErrorText(command ?? "machine-memory", error.message),
      formatErrors: (errors) =>
        prettyErrorText(
          command ?? "machine-memory",
          errors.map((error) => error.message).join("\n"),
        ),
    };
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

function renderHumanCommandFailure(command: string, error: Error): void {
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
  error: Error,
): boolean {
  return (
    command === "reindex" &&
    error instanceof MemoryDatabaseError &&
    error.operation === "vectorize/reindex"
  );
}

function renderMachineError(error: Error): void {
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
    printJson({ error: error.message });
    return;
  }
  printJson({
    error: error instanceof Error ? error.message : "Unexpected CLI failure.",
  });
}

function unknownCommand(args: ReadonlyArray<string>): string | undefined {
  const command = removePrettyFlag(args)[0];
  return command && !command.startsWith("-") && !knownCommands.has(command)
    ? command
    : undefined;
}

function commandPath(args: ReadonlyArray<string>): string | undefined {
  const normalized = removePrettyFlag(args);
  const first = normalized[0];
  const firstTwo = normalized.slice(0, 2).join(" ");
  return HUMAN_COMMANDS.has(firstTwo)
    ? firstTwo
    : first && knownCommands.has(first)
      ? first
      : undefined;
}

function renderError(
  error: Error,
  command: string | undefined,
  pretty: boolean,
): void {
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
  if (pretty) {
    console.error(
      prettyErrorText(
        command ?? "machine-memory",
        error instanceof Error ? error.message : "Unexpected CLI failure.",
      ),
    );
    return;
  }
  renderMachineError(error);
}

export function runCli(args: ReadonlyArray<string>) {
  const command = unknownCommand(args);
  const commandPathName = commandPath(args);
  const pretty = prettyRequested(args);
  const errorCommand =
    commandPathName ??
    (removePrettyFlag(args)[0] === "reindex" ? "reindex" : undefined);
  if (command) {
    return Effect.sync(() => {
      if (pretty) {
        console.error(
          prettyErrorText(
            "machine-memory",
            `Unknown command: ${command}. Run 'machine-memory help' for usage.`,
          ),
        );
      } else {
        printJson({
          error: `Unknown command: ${command}. Run 'machine-memory help' for usage.`,
        });
      }
      process.exitCode = 1;
    });
  }
  return Command.runWith(rootCommand, { version: VERSION })(args).pipe(
    Effect.provide(CliOutput.layer(formatterFor(commandPathName, pretty))),
    Effect.provide(BunServices.layer),
    Effect.catch((error) =>
      Effect.sync(() => {
        const failure =
          error instanceof Error ? error : new Error("Unexpected CLI failure.");
        renderError(failure, errorCommand, pretty);
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

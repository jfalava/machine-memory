import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Option } from "effect";
import {
  Argument,
  CliError,
  CliOutput,
  Command,
  Flag,
} from "effect/unstable/cli";
import { printJson } from "../cli";
import { VERSION } from "../constants";
import { MemoryDatabase, MemoryDatabaseError, layer as databaseLayer } from "../effect/database";
import { CommandError } from "../effect/errors";
import type { DbAccessMode } from "../db";
import { upgrade, UpgradeError } from "../upgrade";
import { handleDoctorCommand } from "./commands/doctor";
import {
  handleCoverageCommand,
  handleExportCommand,
  handleGcCommand,
  handleImportCommand,
  handleMigrateCommand,
  handleStatsCommand,
} from "./commands/maintenance";
import {
  handleDiffCommand,
  handleGetCommand,
  handleListCommand,
  handleQueryCommand,
  handleSuggestCommand,
  handleSweepCommand,
  handleVerifyCommand,
} from "./commands/memory-read";
import {
  handleAddCommand,
  handleDeleteCommand,
  handleDeprecateCommand,
  handleUpdateCommand,
} from "./commands/memory-write";
import { handleTagMapCommand } from "./commands/tag-map";
import { handleUpdateAgentsMdCommand } from "./commands/update-agents-md";
import type { CommandContext } from "./commands/context";
import { helpPayload } from "./help";
import { parseOutputMode } from "./shared";

type FlagSpec = {
  readonly name: string;
  readonly kind: "boolean" | "string";
};

type CommandHandler = (
  context: CommandContext,
) => Effect.Effect<void, unknown, never>;

const positionalArgs = () => Argument.string("arg").pipe(Argument.variadic());
const stringFlag = (name: string) => Flag.string(name).pipe(Flag.optional);
const booleanFlag = (name: string) => Flag.boolean(name);
const stringSpec = (name: string): FlagSpec => ({ name, kind: "string" });
const booleanSpec = (name: string): FlagSpec => ({ name, kind: "boolean" });

const outputConfig = () => ({
  brief: booleanFlag("brief"),
  "json-min": booleanFlag("json-min"),
  quiet: booleanFlag("quiet"),
});

const outputSpecs: readonly FlagSpec[] = [
  booleanSpec("brief"),
  booleanSpec("json-min"),
  booleanSpec("quiet"),
];

function argvFromInput(
  input: Record<string, unknown>,
  specs: readonly FlagSpec[],
): string[] {
  const args = Array.isArray(input.args)
    ? input.args.filter((value): value is string => typeof value === "string")
    : [];
  for (const spec of specs) {
    const value = input[spec.name];
    if (spec.kind === "boolean") {
      if (value === true) {
        args.push(`--${spec.name}`);
      }
      continue;
    }
    if (Option.isSome(value as Option.Option<unknown>)) {
      args.push(`--${spec.name}`, String((value as Option.Some<unknown>).value));
    }
  }
  return args;
}

function commandContext(
  input: Record<string, unknown>,
  specs: readonly FlagSpec[],
  database: CommandContext["database"],
  fileSystem: CommandContext["fileSystem"],
): CommandContext {
  const args = argvFromInput(input, specs);
  return { args, outputMode: parseOutputMode(args), database, fileSystem };
}

function effectCommand<
  const Name extends string,
  const Config extends Command.Command.Config,
>(
  name: Name,
  config: Config,
  specs: readonly FlagSpec[],
  mode: DbAccessMode | undefined,
  handler: CommandHandler,
) {
  return Command.make(name, config, (input) => {
    const resources = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const database = mode ? yield* MemoryDatabase : undefined;
      yield* handler(commandContext(input as Record<string, unknown>, specs, database, fileSystem));
    });
    return (mode
      ? resources.pipe(Effect.provide(databaseLayer(mode)))
      : resources) as Effect.Effect<void, unknown, FileSystem.FileSystem>;
  });
}

const addCommand = effectCommand(
  "add",
  {
    args: positionalArgs(),
    "from-file": stringFlag("from-file"),
    "upsert-match": stringFlag("upsert-match"),
    path: stringFlag("path"),
    tags: stringFlag("tags"),
    context: stringFlag("context"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    "source-agent": stringFlag("source-agent"),
    refs: stringFlag("refs"),
    "expires-after-days": stringFlag("expires-after-days"),
    "no-conflicts": booleanFlag("no-conflicts"),
    ...outputConfig(),
  },
  [
    stringSpec("from-file"),
    stringSpec("upsert-match"),
    stringSpec("path"),
    stringSpec("tags"),
    stringSpec("context"),
    stringSpec("type"),
    stringSpec("certainty"),
    stringSpec("source-agent"),
    stringSpec("refs"),
    stringSpec("expires-after-days"),
    booleanSpec("no-conflicts"),
    ...outputSpecs,
  ],
  "write",
  handleAddCommand,
);

const queryCommand = effectCommand(
  "query",
  {
    args: positionalArgs(),
    tags: stringFlag("tags"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    "include-deprecated": booleanFlag("include-deprecated"),
    limit: stringFlag("limit"),
    "explain-score": booleanFlag("explain-score"),
    ...outputConfig(),
  },
  [
    stringSpec("tags"),
    stringSpec("type"),
    stringSpec("certainty"),
    booleanSpec("include-deprecated"),
    stringSpec("limit"),
    booleanSpec("explain-score"),
    ...outputSpecs,
  ],
  "read",
  handleQueryCommand,
);

const listCommand = effectCommand(
  "list",
  {
    args: positionalArgs(),
    tags: stringFlag("tags"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    status: stringFlag("status"),
    "include-deprecated": booleanFlag("include-deprecated"),
    limit: stringFlag("limit"),
    ...outputConfig(),
  },
  [
    stringSpec("tags"),
    stringSpec("type"),
    stringSpec("certainty"),
    stringSpec("status"),
    booleanSpec("include-deprecated"),
    stringSpec("limit"),
    ...outputSpecs,
  ],
  "read",
  handleListCommand,
);

const getCommand = effectCommand("get", { args: positionalArgs() }, [], "read", handleGetCommand);
const updateCommand = effectCommand(
  "update",
  {
    args: positionalArgs(),
    match: stringFlag("match"),
    "from-file": stringFlag("from-file"),
    tags: stringFlag("tags"),
    context: stringFlag("context"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    "updated-by": stringFlag("updated-by"),
    refs: stringFlag("refs"),
    "expires-after-days": stringFlag("expires-after-days"),
  },
  [
    stringSpec("match"), stringSpec("from-file"), stringSpec("tags"),
    stringSpec("context"), stringSpec("type"), stringSpec("certainty"),
    stringSpec("updated-by"), stringSpec("refs"), stringSpec("expires-after-days"),
  ],
  "write",
  handleUpdateCommand,
);
const deprecateCommand = effectCommand(
  "deprecate",
  { args: positionalArgs(), match: stringFlag("match"), "superseded-by": stringFlag("superseded-by"), "updated-by": stringFlag("updated-by") },
  [stringSpec("match"), stringSpec("superseded-by"), stringSpec("updated-by")],
  "write",
  handleDeprecateCommand,
);
const deleteCommand = effectCommand("delete", { args: positionalArgs() }, [], "write", handleDeleteCommand);

const suggestCommand = effectCommand(
  "suggest",
  {
    args: positionalArgs(), files: stringFlag("files"), "files-json": stringFlag("files-json"),
    tags: stringFlag("tags"), type: stringFlag("type"), certainty: stringFlag("certainty"),
    "include-deprecated": booleanFlag("include-deprecated"), limit: stringFlag("limit"),
    "explain-score": booleanFlag("explain-score"), ...outputConfig(),
  },
  [stringSpec("files"), stringSpec("files-json"), stringSpec("tags"), stringSpec("type"), stringSpec("certainty"), booleanSpec("include-deprecated"), stringSpec("limit"), booleanSpec("explain-score"), ...outputSpecs],
  "read",
  handleSuggestCommand,
);
const sweepCommand = effectCommand(
  "sweep",
  { args: positionalArgs(), files: stringFlag("files"), "files-json": stringFlag("files-json"), query: stringFlag("query"), tags: stringFlag("tags"), limit: stringFlag("limit"), ...outputConfig() },
  [stringSpec("files"), stringSpec("files-json"), stringSpec("query"), stringSpec("tags"), stringSpec("limit"), ...outputSpecs],
  "read",
  handleSweepCommand,
);

const doctorCommand = effectCommand("doctor", outputConfig(), outputSpecs, "read", handleDoctorCommand);
const verifyCommand = effectCommand("verify", { args: positionalArgs() }, [], "read", handleVerifyCommand);
const diffCommand = effectCommand("diff", { args: positionalArgs() }, [], "read", handleDiffCommand);
const coverageCommand = effectCommand("coverage", { args: positionalArgs(), root: stringFlag("root") }, [stringSpec("root")], "read", handleCoverageCommand);
const gcCommand = effectCommand("gc", { args: positionalArgs(), "dry-run": booleanFlag("dry-run") }, [booleanSpec("dry-run")], "read", handleGcCommand);
const statsCommand = effectCommand("stats", {}, [], "read", handleStatsCommand);
const importCommand = effectCommand("import", { args: positionalArgs() }, [], "write", handleImportCommand);
const exportCommand = effectCommand("export", { args: positionalArgs(), tags: stringFlag("tags"), type: stringFlag("type"), certainty: stringFlag("certainty"), since: stringFlag("since") }, [stringSpec("tags"), stringSpec("type"), stringSpec("certainty"), stringSpec("since")], "read", handleExportCommand);
const migrateCommand = effectCommand("migrate", {}, [], "write", handleMigrateCommand);
const tagMapCommand = effectCommand("tag-map", { args: positionalArgs() }, [], undefined, handleTagMapCommand);
const updateAgentsCommand = effectCommand("update-agents-md", {}, [], undefined, handleUpdateAgentsMdCommand);

const helpCommand = Command.make("help", {}, () => Effect.sync(() => printJson(helpPayload())));
const versionCommand = Command.make("version", {}, () => Effect.sync(() => printJson({ version: VERSION })));
const upgradeCommand = Command.make("upgrade", {}, () =>
  upgrade().pipe(Effect.tap((result) => Effect.sync(() => printJson(result)))),
);

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
).pipe(
  Command.withSubcommands([
    helpCommand, versionCommand, upgradeCommand, addCommand, queryCommand,
    listCommand, getCommand, updateCommand, deprecateCommand, deleteCommand,
    suggestCommand, sweepCommand, doctorCommand, verifyCommand, diffCommand,
    coverageCommand, gcCommand, statsCommand, importCommand, exportCommand,
    migrateCommand, tagMapCommand, updateAgentsCommand,
  ]),
);

const knownCommands = new Set([
  "help", "version", "upgrade", "add", "query", "list", "get", "update",
  "deprecate", "delete", "suggest", "sweep", "doctor", "verify", "diff",
  "coverage", "gc", "stats", "import", "export", "migrate", "tag-map",
  "update-agents-md",
]);

const formatter: CliOutput.Formatter = {
  ...CliOutput.defaultFormatter({ colors: false }),
  formatHelpDoc: () => JSON.stringify(helpPayload()),
  formatVersion: (_name, version) => JSON.stringify({ version }),
  formatCliError: (error) => JSON.stringify({ error: error.message }),
  formatError: (error) => JSON.stringify({ error: error.message }),
  formatErrors: (errors) => JSON.stringify({ error: errors.map((error) => error.message).join("\n") }),
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
    printJson({ error: error.message, ...(error instanceof MemoryDatabaseError ? { operation: error.operation } : {}) });
    return;
  }
  printJson({ error: error instanceof Error ? error.message : "Unexpected CLI failure." });
}

export function runCli(args: ReadonlyArray<string>) {
  const command = unknownCommand(args);
  if (command) {
    return Effect.sync(() => {
      printJson({ error: `Unknown command: ${command}. Run 'machine-memory help' for usage.` });
      process.exitCode = 1;
    });
  }
  return Command.runWith(rootCommand, { version: VERSION })(args).pipe(
    Effect.provide(CliOutput.layer(formatter)),
    Effect.provide(BunServices.layer),
    Effect.catch((error) =>
      Effect.sync(() => {
        renderError(error);
        if (!(CliError.isCliError(error) && error._tag === "ShowHelp" && error.errors.length === 0)) {
          process.exitCode = 1;
        }
      }),
    ),
  );
}

import { Database } from "bun:sqlite";
import { Effect, Option } from "effect";
import {
  Argument,
  CliError,
  CliOutput,
  Command,
  Flag,
} from "effect/unstable/cli";
import { printJson } from "../cli";
import { VERSION } from "../constants";
import { upgrade, UpgradeError } from "../upgrade";
import { BunServices } from "@effect/platform-bun";
import {
  layer as memoryDatabaseLayer,
  MemoryDatabase,
  MemoryDatabaseError,
} from "../effect/database";
import type { DbAccessMode } from "../db";
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
import { helpPayload } from "./help";
import { parseOutputMode, parseSqliteErrorDetails } from "./shared";
import type { CommandContext } from "./commands/context";

type FlagSpec = {
  readonly name: string;
  readonly kind: "boolean" | "string";
};

const positionalArgs = () => Argument.string("arg").pipe(Argument.variadic());

const stringFlag = (name: string) => Flag.string(name).pipe(Flag.optional);

const booleanFlag = (name: string) => Flag.boolean(name);

const stringSpec = (name: string): FlagSpec => ({ name, kind: "string" });

const booleanSpec = (name: string): FlagSpec => ({
  name,
  kind: "boolean",
});

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

function legacyArgs(
  input: Record<string, unknown>,
  specs: readonly FlagSpec[],
): string[] {
  const args = Array.isArray(input.args)
    ? input.args.filter((arg): arg is string => typeof arg === "string")
    : [];

  for (const spec of specs) {
    const value = input[spec.name];
    if (spec.kind === "boolean") {
      if (value === true) {
        args.push(`--${spec.name}`);
      }
      continue;
    }
    const option = value as Option.Option<unknown>;
    if (Option.isSome(option)) {
      args.push(`--${spec.name}`, String(option.value));
    }
  }
  return args;
}

function legacyCommand<
  const Name extends string,
  const Config extends Command.Command.Config,
>(name: Name, config: Config, specs: readonly FlagSpec[], mode?: DbAccessMode) {
  return Command.make(name, config, (input) => {
    const args = legacyArgs(input as Record<string, unknown>, specs);
    const run = mode
      ? Effect.gen(function* () {
          const database = yield* MemoryDatabase;
          yield* Effect.promise(() =>
            runLegacyCommand(name, args, database.database),
          );
        }).pipe(Effect.provide(memoryDatabaseLayer(mode)))
      : Effect.promise(() => runLegacyCommand(name, args));
    return run;
  });
}

const addCommand = legacyCommand(
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
);

const queryCommand = legacyCommand(
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
);

const listCommand = legacyCommand(
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
);

const getCommand = legacyCommand("get", { args: positionalArgs() }, [], "read");

const updateCommand = legacyCommand(
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
    stringSpec("match"),
    stringSpec("from-file"),
    stringSpec("tags"),
    stringSpec("context"),
    stringSpec("type"),
    stringSpec("certainty"),
    stringSpec("updated-by"),
    stringSpec("refs"),
    stringSpec("expires-after-days"),
  ],
  "write",
);

const deprecateCommand = legacyCommand(
  "deprecate",
  {
    args: positionalArgs(),
    match: stringFlag("match"),
    "superseded-by": stringFlag("superseded-by"),
    "updated-by": stringFlag("updated-by"),
  },
  [stringSpec("match"), stringSpec("superseded-by"), stringSpec("updated-by")],
  "write",
);

const deleteCommand = legacyCommand(
  "delete",
  { args: positionalArgs() },
  [],
  "write",
);

const suggestCommand = legacyCommand(
  "suggest",
  {
    args: positionalArgs(),
    files: stringFlag("files"),
    "files-json": stringFlag("files-json"),
    tags: stringFlag("tags"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    "include-deprecated": booleanFlag("include-deprecated"),
    limit: stringFlag("limit"),
    "explain-score": booleanFlag("explain-score"),
    ...outputConfig(),
  },
  [
    stringSpec("files"),
    stringSpec("files-json"),
    stringSpec("tags"),
    stringSpec("type"),
    stringSpec("certainty"),
    booleanSpec("include-deprecated"),
    stringSpec("limit"),
    booleanSpec("explain-score"),
    ...outputSpecs,
  ],
  "read",
);

const sweepCommand = legacyCommand(
  "sweep",
  {
    args: positionalArgs(),
    files: stringFlag("files"),
    "files-json": stringFlag("files-json"),
    query: stringFlag("query"),
    tags: stringFlag("tags"),
    limit: stringFlag("limit"),
    ...outputConfig(),
  },
  [
    stringSpec("files"),
    stringSpec("files-json"),
    stringSpec("query"),
    stringSpec("tags"),
    stringSpec("limit"),
    ...outputSpecs,
  ],
  "read",
);

const doctorCommand = legacyCommand(
  "doctor",
  outputConfig(),
  outputSpecs,
  "read",
);

const verifyCommand = legacyCommand(
  "verify",
  { args: positionalArgs() },
  [],
  "read",
);

const diffCommand = legacyCommand(
  "diff",
  { args: positionalArgs() },
  [],
  "read",
);

const coverageCommand = legacyCommand(
  "coverage",
  { args: positionalArgs(), root: stringFlag("root") },
  [stringSpec("root")],
  "read",
);

const gcCommand = legacyCommand(
  "gc",
  { args: positionalArgs(), "dry-run": booleanFlag("dry-run") },
  [booleanSpec("dry-run")],
  "read",
);

const statsCommand = legacyCommand("stats", {}, [], "read");

const importCommand = legacyCommand(
  "import",
  { args: positionalArgs() },
  [],
  "write",
);

const exportCommand = legacyCommand(
  "export",
  {
    args: positionalArgs(),
    tags: stringFlag("tags"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    since: stringFlag("since"),
  },
  [
    stringSpec("tags"),
    stringSpec("type"),
    stringSpec("certainty"),
    stringSpec("since"),
  ],
  "read",
);

const migrateCommand = legacyCommand("migrate", {}, [], "write");

const tagMapCommand = legacyCommand("tag-map", { args: positionalArgs() }, []);

const updateAgentsCommand = legacyCommand("update-agents-md", {}, []);

const helpCommand = Command.make("help", {}, () =>
  Effect.sync(() => printJson(helpPayload())),
);

const versionCommand = Command.make("version", {}, () =>
  Effect.sync(() => printJson({ version: VERSION })),
);

const upgradeCommand = Command.make("upgrade", {}, () =>
  upgrade().pipe(Effect.tap((result) => Effect.sync(() => printJson(result)))),
);

const rootCommand = Command.make("machine-memory", {}, () =>
  Effect.sync(() => {
    printJson(helpPayload());
    process.exitCode = 1;
  }),
).pipe(
  Command.withSubcommands([
    helpCommand,
    versionCommand,
    upgradeCommand,
    addCommand,
    queryCommand,
    listCommand,
    getCommand,
    updateCommand,
    deprecateCommand,
    deleteCommand,
    suggestCommand,
    sweepCommand,
    doctorCommand,
    verifyCommand,
    diffCommand,
    coverageCommand,
    gcCommand,
    statsCommand,
    importCommand,
    exportCommand,
    migrateCommand,
    tagMapCommand,
    updateAgentsCommand,
  ]),
);

const knownCommands = new Set([
  "help",
  "version",
  "upgrade",
  "add",
  "query",
  "list",
  "get",
  "update",
  "deprecate",
  "delete",
  "suggest",
  "sweep",
  "doctor",
  "verify",
  "diff",
  "coverage",
  "gc",
  "stats",
  "import",
  "export",
  "migrate",
  "tag-map",
  "update-agents-md",
]);

const formatter: CliOutput.Formatter = {
  ...CliOutput.defaultFormatter({ colors: false }),
  formatHelpDoc: (_doc) => JSON.stringify(helpPayload()),
  formatVersion: (_name, version) => JSON.stringify({ version }),
  formatCliError: (error) => JSON.stringify({ error: error.message }),
  formatError: (error) => JSON.stringify({ error: error.message }),
  formatErrors: (errors) =>
    JSON.stringify({
      error: errors.map((error) => error.message).join("\n"),
    }),
};

function isUnknownTopLevelCommand(
  args: ReadonlyArray<string>,
): string | undefined {
  const command = args[0];
  return command && !command.startsWith("-") && !knownCommands.has(command)
    ? command
    : undefined;
}

export async function runCli(args: ReadonlyArray<string>): Promise<void> {
  const unknownCommand = isUnknownTopLevelCommand(args);
  if (unknownCommand) {
    printJson({
      error: `Unknown command: ${unknownCommand}. Run 'machine-memory help' for usage.`,
    });
    process.exitCode = 1;
    return;
  }

  try {
    const program = Command.runWith(rootCommand, { version: VERSION })(
      args,
    ).pipe(
      Effect.provide(CliOutput.layer(formatter)),
      Effect.provide(BunServices.layer),
    );
    await Effect.runPromise(program as Effect.Effect<void, unknown, never>);
  } catch (error) {
    if (CliError.isCliError(error) && error._tag === "ShowHelp") {
      process.exitCode = error.errors.length > 0 ? 1 : 0;
      return;
    }
    if (error instanceof UpgradeError) {
      printJson(error.payload);
      process.exitCode = 1;
      return;
    }
    if (error instanceof MemoryDatabaseError) {
      printJson({
        error: error.message,
        operation: error.operation,
      });
      process.exitCode = 1;
      return;
    }
    printJson({
      error: error instanceof Error ? error.message : "Unexpected CLI failure.",
    });
    process.exitCode = 1;
  }
}

async function runLegacyCommand(
  command: string,
  args: string[],
  database?: Database,
): Promise<void> {
  if (command === "tag-map") {
    handleTagMapCommand(args);
    return;
  }

  if (command === "update-agents-md") {
    await handleUpdateAgentsMdCommand();
    return;
  }

  const outputMode = parseOutputMode(args);

  const requireDb = (): Database => {
    if (!database) {
      throw new Error("Database is not initialized for this command.");
    }
    return database;
  };

  const commandContext: CommandContext = {
    args,
    outputMode,
    requireDb,
  };

  try {
    switch (command) {
      case "add":
        handleAddCommand(commandContext);
        break;
      case "query":
        handleQueryCommand(commandContext);
        break;
      case "get":
        handleGetCommand(commandContext);
        break;
      case "update":
        handleUpdateCommand(commandContext);
        break;
      case "deprecate":
        handleDeprecateCommand(commandContext);
        break;
      case "delete":
        handleDeleteCommand(commandContext);
        break;
      case "list":
        handleListCommand(commandContext);
        break;
      case "suggest":
        handleSuggestCommand(commandContext);
        break;
      case "sweep":
        handleSweepCommand(commandContext);
        break;
      case "doctor":
        handleDoctorCommand(commandContext);
        break;
      case "verify":
        handleVerifyCommand(commandContext);
        break;
      case "diff":
        handleDiffCommand(commandContext);
        break;
      case "coverage":
        handleCoverageCommand(commandContext);
        break;
      case "gc":
        handleGcCommand(commandContext);
        break;
      case "stats":
        handleStatsCommand(commandContext);
        break;
      case "import":
        handleImportCommand(commandContext);
        break;
      case "export":
        handleExportCommand(commandContext);
        break;
      case "migrate":
        handleMigrateCommand();
        break;
    }
  } catch (error) {
    const details = parseSqliteErrorDetails(error);
    const payload: Record<string, unknown> = {
      error: details.message,
      command,
    };
    if (details.hint) {
      payload.hint = details.hint;
    }
    if (error instanceof Error) {
      payload.details = error.message;
    }
    printJson(payload);
    process.exitCode = 1;
  }
}

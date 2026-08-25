import { Effect, FileSystem, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { MemoryDatabase, layer as databaseLayer } from "../../effect/database";
import type { DatabaseBackendFlags } from "../../database-config";
import type { DbAccessMode } from "../../db";
import { jsonString, type JsonObject } from "../../json";
import type { CommandContext } from "./context";
import { parseOutputMode, prettyOutput } from "./output";

export type FlagSpec = {
  readonly name: string;
  readonly kind: "boolean" | "string";
};

export type CommandHandler = (
  context: CommandContext,
) => Effect.Effect<void, unknown, never>;

type CommandInput = JsonObject;

export const positionalArgs = () =>
  Argument.string("arg").pipe(Argument.variadic());
export const stringFlag = (name: string) =>
  Flag.string(name).pipe(Flag.optional);
export const booleanFlag = (name: string) =>
  Flag.boolean(name).pipe(Flag.withDefault(false));
export const stringSpec = (name: string): FlagSpec => ({
  name,
  kind: "string",
});
export const booleanSpec = (name: string): FlagSpec => ({
  name,
  kind: "boolean",
});

export const outputConfig = () => ({
  brief: booleanFlag("brief"),
  "json-min": booleanFlag("json-min"),
  quiet: booleanFlag("quiet"),
});

export const outputSpecs: readonly FlagSpec[] = [
  booleanSpec("brief"),
  booleanSpec("json-min"),
  booleanSpec("quiet"),
];

const databaseBackendConfig = {
  local: booleanFlag("local"),
  remote: booleanFlag("remote"),
};

const databaseBackendSpecs: readonly FlagSpec[] = [
  booleanSpec("local"),
  booleanSpec("remote"),
];

function argvFromInput(
  input: CommandInput,
  specs: readonly FlagSpec[],
): string[] {
  const args = Array.isArray(input.args)
    ? input.args.flatMap((value) => {
        const parsed = jsonString(value);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
  for (const spec of specs) {
    const value = input[spec.name];
    if (spec.kind === "boolean") {
      if (value === true) {
        args.push(`--${spec.name}`);
      }
      continue;
    }
    if (Option.isOption(value) && Option.isSome(value)) {
      args.push(`--${spec.name}`, String(value.value));
    }
  }
  return args;
}

function commandContext(options: {
  command: string;
  input: CommandInput;
  specs: readonly FlagSpec[];
  database: CommandContext["database"];
  fileSystem: CommandContext["fileSystem"];
  pretty: boolean;
}): CommandContext {
  const args = argvFromInput(options.input, options.specs);
  return {
    args,
    command: options.command,
    outputMode: parseOutputMode(args, options.pretty),
    database: options.database,
    fileSystem: options.fileSystem,
  };
}

export function effectCommand<
  const Name extends string,
  const Config extends Command.Command.Config,
>(
  name: Name,
  config: Config,
  specs: readonly FlagSpec[],
  mode: DbAccessMode | undefined,
  handler: CommandHandler,
) {
  const commandConfig = mode ? { ...config, ...databaseBackendConfig } : config;
  const commandSpecs = mode ? [...specs, ...databaseBackendSpecs] : specs;

  return Command.make(name, commandConfig, (input) => {
    // SAFETY: the CLI parsed input against commandSpecs before this handler runs.
    const inputRecord = input as CommandInput;
    const backendFlags: DatabaseBackendFlags = {
      local: inputRecord.local === true,
      remote: inputRecord.remote === true,
    };
    const resources = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const database = mode ? yield* MemoryDatabase : undefined;
      const pretty = yield* prettyOutput;
      yield* handler(
        commandContext({
          command: name,
          input: inputRecord,
          specs: commandSpecs,
          database,
          fileSystem,
          pretty,
        }),
      );
    });
    // SAFETY: databaseLayer(mode) supplies MemoryDatabase, leaving FileSystem.FileSystem
    // as the only remaining requirement; the error channel is deliberately unknown.
    return (
      mode
        ? resources.pipe(Effect.provide(databaseLayer(mode, backendFlags)))
        : resources
    ) as Effect.Effect<void, unknown, FileSystem.FileSystem>;
  });
}

import { Effect, FileSystem, Option } from "effect";
import {
  Argument,
  Command,
  Flag,
} from "effect/unstable/cli";
import {
  MemoryDatabase,
  layer as databaseLayer,
} from "../../effect/database";
import type { DbAccessMode } from "../../db";
import type { CommandContext } from "./context";
import { parseOutputMode } from "./output";

export type FlagSpec = {
  readonly name: string;
  readonly kind: "boolean" | "string";
};

export type CommandHandler = (
  context: CommandContext,
) => Effect.Effect<void, unknown, never>;

export const positionalArgs = () => Argument.string("arg").pipe(Argument.variadic());
export const stringFlag = (name: string) => Flag.string(name).pipe(Flag.optional);
export const booleanFlag = (name: string) => Flag.boolean(name);
export const stringSpec = (name: string): FlagSpec => ({ name, kind: "string" });
export const booleanSpec = (name: string): FlagSpec => ({ name, kind: "boolean" });

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
      args.push(
        `--${spec.name}`,
        String((value as Option.Some<unknown>).value),
      );
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
  return Command.make(name, config, (input) => {
    const resources = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const database = mode ? yield* MemoryDatabase : undefined;
      yield* handler(
        commandContext(
          input as Record<string, unknown>,
          specs,
          database,
          fileSystem,
        ),
      );
    });
    return (
      mode ? resources.pipe(Effect.provide(databaseLayer(mode))) : resources
    ) as Effect.Effect<void, unknown, FileSystem.FileSystem>;
  });
}

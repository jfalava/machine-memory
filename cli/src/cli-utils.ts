import { CommandError } from "./effect/errors";
import type { JsonValue } from "./json";

export function printJson(data: JsonValue) {
  console.info(JSON.stringify(data));
}

export function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) {
    return undefined;
  }
  return args[idx + 1];
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function usageError(message: string): never {
  throw new CommandError({ message, command: "cli", cause: undefined });
}

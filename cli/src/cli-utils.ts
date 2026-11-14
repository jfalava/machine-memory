import { CommandError } from "./effect/errors";
import type { JsonValue } from "./json";

export function printJson(data: JsonValue) {
  console.info(JSON.stringify(data));
}

/**
 * One line on stderr. Warnings about lost content or a wrong repository go
 * here in every output mode, so piping stdout through jq, head or cut cannot
 * hide them.
 */
export function warnOnStderr(message: string): void {
  console.error(`machine-memory: ${message}`);
}

/** Parsed command flags keyed by `--name`: string flags map to their value, set boolean flags to `true`. */
export type CommandFlags = ReadonlyMap<string, string | true>;

export function getFlagValue(
  flags: CommandFlags,
  flag: string,
): string | undefined {
  const value = flags.get(flag);
  return value === true ? undefined : value;
}

export function hasFlag(flags: CommandFlags, flag: string): boolean {
  return flags.has(flag);
}

export function usageError(message: string): never {
  throw new CommandError({ message, command: "cli", cause: undefined });
}

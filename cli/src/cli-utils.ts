import { CommandError } from "./effect/errors";
import type { JsonValue } from "./json";

let asciiOnly = false;

/** --ascii: print only 7-bit ASCII, for tools that treat other bytes as binary. */
export function setAsciiOutput(enabled: boolean): void {
  asciiOnly = enabled;
}

/**
 * With --ascii, every other character as a \uXXXX escape. JSON parsers read
 * the escapes back as the original text, so JSON output loses nothing.
 */
export function asciiSafe(text: string): string {
  return asciiOnly
    ? text.replaceAll(
        /[\u0080-\uffff]/g,
        (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
      )
    : text;
}

export function printJson(data: JsonValue) {
  console.info(asciiSafe(JSON.stringify(data)));
}

/**
 * One line on stderr. Warnings about lost content or a wrong repository go
 * here in every output mode, so piping stdout through jq, head or cut cannot
 * hide them.
 */
export function warnOnStderr(message: string): void {
  console.error(asciiSafe(`machine-memory: ${message}`));
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

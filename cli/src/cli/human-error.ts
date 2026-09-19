import pc from "picocolors";
import { CommandError, commandError } from "../effect/errors";

export function humanHintLine(hint: string): string {
  return `  ${pc.dim("Hint")}  ${hint}`;
}

export function humanCommandFailureOutput(error: CommandError) {
  return {
    stderr: [
      "",
      pc.red(pc.bold(`✗ ${error.command} failed`)),
      `  ${String(error.message)}`,
      "",
    ],
    stdout: error.hint ? [humanHintLine(error.hint), ""] : [],
  };
}

export function commandErrorForRender(
  command: string,
  error: Error,
): CommandError {
  if (error instanceof CommandError) {
    if (error.command === command) {
      return error;
    }
    return commandError(command, error.message, error.cause, error.hint);
  }
  return commandError(command, error.message);
}

export function storedRemoteCredentialsError(
  cause: unknown,
  command: string,
): CommandError {
  const causeMessage = cause instanceof Error ? cause.message : "";
  if (causeMessage.includes("Stored remote credentials are invalid")) {
    return commandError(
      command,
      "Stored remote credentials are invalid.",
      cause,
      "Set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKEN, or overwrite them with machine-memory remote setup --url <worker-url> --token <worker-token>.",
    );
  }
  return commandError(
    command,
    "Could not read stored remote credentials from the OS keychain.",
    cause,
    "Unlock the OS keychain, or set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKEN.",
  );
}

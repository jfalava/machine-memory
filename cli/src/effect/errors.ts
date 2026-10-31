import { databaseFailureGuidance } from "@machine-memory/contract";
import { Schema } from "effect";

export class CommandError extends Schema.TaggedError<CommandError>()(
  "CommandError",
  {
    message: Schema.String,
    command: Schema.String,
    cause: Schema.Unknown,
    hint: Schema.optionalKey(Schema.String),
  },
) {}

export class MemoryDatabaseError extends Schema.TaggedError<MemoryDatabaseError>()(
  "MemoryDatabaseError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export function commandError(
  command: string,
  message: string,
  cause?: unknown,
  hint?: string,
): CommandError {
  if (hint) {
    return new CommandError({ message, command, cause, hint });
  }
  return new CommandError({ message, command, cause });
}

/** Maps a database failure to MemoryDatabaseError, preferring contract guidance text. */
export function databaseOperationError(
  operation: string,
  cause: unknown,
): MemoryDatabaseError {
  const guidance = databaseFailureGuidance(cause);
  return new MemoryDatabaseError({
    operation,
    message:
      guidance?.error ??
      (cause instanceof Error ? cause.message : "Database operation failed."),
    cause,
  });
}

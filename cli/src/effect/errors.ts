import { Schema } from "effect";

export class CommandError extends Schema.TaggedError<CommandError>()(
  "CommandError",
  {
    message: Schema.String,
    command: Schema.String,
    cause: Schema.Unknown,
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
): CommandError {
  return new CommandError({ message, command, cause });
}

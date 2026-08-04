import { Schema } from "effect";

export class CommandError extends Schema.TaggedErrorClass<CommandError>()(
  "CommandError",
  {
    message: Schema.String,
    command: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class MemoryDatabaseError extends Schema.TaggedErrorClass<MemoryDatabaseError>()(
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
  cause: unknown = undefined,
): CommandError {
  return new CommandError({ message, command, cause });
}

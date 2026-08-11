import type { FileSystem } from "effect/FileSystem";
import type { MemoryDatabaseApi } from "../../effect/database";
import { CommandError } from "../../effect/errors";
import type { OutputMode } from "./output";

export type CommandContext = {
  args: string[];
  command: string;
  outputMode: OutputMode;
  database: MemoryDatabaseApi | undefined;
  fileSystem: FileSystem;
};

export function requireDatabase(context: CommandContext): MemoryDatabaseApi {
  if (!context.database) {
    throw new CommandError({
      message: "This command requires the memory database.",
      command: "cli",
      cause: undefined,
    });
  }
  return context.database;
}

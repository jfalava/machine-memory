import type { FileSystem } from "effect/FileSystem";
import type { MemoryDatabaseApi } from "../../effect/database";
import type { OutputMode } from "../shared";
import { CommandError } from "../../effect/errors";

export type CommandContext = {
  args: string[];
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

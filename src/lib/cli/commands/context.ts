import { Database } from "bun:sqlite";
import type { OutputMode } from "../shared";

export type CommandContext = {
  args: string[];
  outputMode: OutputMode;
  requireDb: () => Database;
};

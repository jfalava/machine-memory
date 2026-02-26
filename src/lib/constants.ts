import { resolve } from "node:path";

export const VERSION = "0.1.0";
export const REPO = "jfalava/machine-memory";
export const DB_PATH = resolve(process.cwd(), ".agents", "memory.db");

export const MEMORY_TYPES = [
  "decision",
  "convention",
  "gotcha",
  "preference",
  "constraint",
] as const;

export const CERTAINTY_LEVELS = ["hard", "soft", "uncertain"] as const;
export const MEMORY_STATUSES = ["active", "deprecated", "superseded_by"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type Certainty = (typeof CERTAINTY_LEVELS)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export type CommonFilters = {
  tag?: string;
  memoryType?: MemoryType;
  certainty?: Certainty;
  status?: MemoryStatus;
  includeDeprecated: boolean;
};

import { isAbsolute, resolve } from "node:path";

import type {
  Certainty,
  MemoryStatus,
  MemoryType,
} from "@machine-memory/contract";

import pkg from "../package.json";

export const VERSION = pkg.version;
export const REPO = "jfalava/machine-memory";
const configuredDbPath = process.env["MACHINE_MEMORY_DB_PATH"];
export const DB_PATH = configuredDbPath
  ? isAbsolute(configuredDbPath)
    ? configuredDbPath
    : resolve(process.cwd(), configuredDbPath)
  : resolve(process.cwd(), "machine-memory.db");

export {
  CERTAINTY_LEVELS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type Certainty,
  type MemoryStatus,
  type MemoryType,
} from "@machine-memory/contract";

export type CommonFilters = {
  tag?: string;
  memoryType?: MemoryType;
  certainty?: Certainty;
  status?: MemoryStatus;
  includeDeprecated: boolean;
};

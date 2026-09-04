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
  CLI_LIMIT_MAX,
  DEFAULT_CERTAINTY,
  DEFAULT_MEMORY_STATUS,
  DEFAULT_MEMORY_TYPE,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  MAX_EMBEDDING_TOKENS,
  MAX_NAMESPACE_BYTES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_MODES,
  UPSERT_DEFAULT_MIN_SCORE,
  UPSERT_MIN_SIMILARITY,
  type Certainty,
  type MemoryStatus,
  type MemoryType,
  type SearchMode,
} from "@machine-memory/contract";

export type CommonFilters = {
  tag?: string;
  memoryType?: MemoryType;
  certainty?: Certainty;
  status?: MemoryStatus;
  includeDeprecated: boolean;
};

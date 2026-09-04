/**
 * MCP memory server barrel.
 *
 * The implementation lives in `./mcp/*` (one concern per module) and shares
 * its wire vocabulary, limits, and embedding budget with
 * `@machine-memory/contract` — the same integration the API worker and the
 * CLI remote paths use. This file only re-exports the public surface so
 * existing imports (`../mcp`, `../mcp.ts`) keep working.
 */
export {
  SEARCH_LIMIT_DEFAULT as DEFAULT_SEARCH_LIMIT,
  SEARCH_LIMIT_MAX as MAX_SEARCH_LIMIT,
} from "@machine-memory/contract";
export { MCP_SERVER_VERSION, createMemoryServer } from "./mcp/tools";
export type {
  ErrorToolResult,
  FtsRankedMemoryRow,
  McpBindings,
  MemoryRow,
  RankedMemoryRow,
  ScoredMemoryRow,
  TextToolResult,
} from "./mcp/types";
export { compareMemoryFact, contentHead } from "./mcp/facts";
export type { FactCheckResult } from "./mcp/facts";
export {
  detectMemoryConflicts,
  findBestMemoryMatch,
  scoredResultRow,
  scoreMemoryRows,
} from "./mcp/scoring";
export {
  deriveFileNeighborhood,
  extractPathTerms,
  normalizeSuggestPath,
  parseSuggestFilesParam,
} from "./mcp/suggest";
export type { FileNeighborhood } from "./mcp/suggest";
export type { MemoryWriteResult, UpsertMatchInfo } from "./mcp/write";

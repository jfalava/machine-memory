/** Raw Cloudflare bindings the MCP tools operate on. */
export type McpBindings = {
  readonly DB: D1Database;
  readonly VECTORIZE: Vectorize;
  readonly AI: Ai;
};

export type MemoryRow = {
  readonly id: number;
  readonly repository: string;
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memory_type: string;
  readonly status: string;
  readonly certainty: string;
};

export type TextToolResult = {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
};

export type ErrorToolResult = TextToolResult & { readonly isError: true };

/** D1 memory row plus the columns ranking needs. */
export type RankedMemoryRow = MemoryRow & {
  readonly updated_at: string;
  readonly update_count: number;
};

export type FtsRankedMemoryRow = RankedMemoryRow & {
  readonly fts_rank: number;
};

export type ScoredMemoryRow = RankedMemoryRow & {
  readonly score: number;
};

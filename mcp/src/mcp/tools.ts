import { McpServer } from "@modelcontextprotocol/server";
import pkg from "../../package.json";
import { postProduct, ProductApiError } from "./product-client";
import { errorResult, textMessage, textResult } from "./text";
import {
  listRepositoriesInput,
  memoryAddInput,
  memoryDeleteInput,
  memoryDeleteManyInput,
  memoryDeprecateInput,
  memoryDoctorInput,
  memoryDiffInput,
  memoryGcInput,
  memoryGetInput,
  memoryListInput,
  memoryQueryInput,
  memorySizeInput,
  memorySuggestInput,
  memoryStatsInput,
  memoryUpdateInput,
  memoryVerifyInput,
  type ListRepositoriesArgs,
  type MemoryAddArgs,
  type MemoryDeleteArgs,
  type MemoryDeleteManyArgs,
  type MemoryDeprecateArgs,
  type MemoryDoctorArgs,
  type MemoryDiffArgs,
  type MemoryGcArgs,
  type MemoryGetArgs,
  type MemoryListArgs,
  type MemoryQueryArgs,
  type MemorySizeArgs,
  type MemorySuggestArgs,
  type MemoryStatsArgs,
  type MemoryUpdateArgs,
  type MemoryVerifyArgs,
} from "./tool-schemas";
import type { ErrorToolResult, McpBindings, TextToolResult } from "./types";

/** Same version as the monorepo CLI / package.json (not a separate MCP protocol number). */
export const MCP_SERVER_VERSION: string = pkg.version;

/**
 * Map a product-route failure onto the MCP read-tool contract: the API's
 * 404 not-found messages pass through as plain text (same wording the
 * direct-DB tools used to emit); everything else is a tool error.
 */
function notFoundOrError(cause: unknown): TextToolResult | ErrorToolResult {
  if (cause instanceof ProductApiError && cause.status === 404) {
    return textMessage(cause.message);
  }
  return errorResult(cause);
}

/**
 * API-only gateway: every tool POSTs its (already MCP-validated) args to
 * the matching API `/product/*` route and unwraps the contract success
 * envelope into the exact output shape the direct-DB tools returned, so
 * agent-facing behavior is unchanged while D1/Vectorize/AI live only in
 * the API worker.
 */
export function createMemoryServer(
  bindings: McpBindings,
  authenticatedLogin?: string,
): McpServer {
  const server = new McpServer({
    name: "machine-memory",
    version: MCP_SERVER_VERSION,
  });
  const { api, apiToken } = bindings;

  const ownerHint = authenticatedLogin
    ? ` The authenticated GitHub user is '${authenticatedLogin}', so repositories under that owner (e.g. '${authenticatedLogin}/repo-name') are likely candidates. Call list_repositories first if unsure.`
    : " Call list_repositories first if you are unsure which repository slug to use.";

  server.registerTool(
    "list_repositories",
    {
      description:
        "List repository slugs (owner/name) with total, active, deprecated, and superseded counts. The response includes pagination metadata; use offset while has_more is true. Call this before any mutating tool when you are not certain which repository slug to use. Reads can proceed loosely — a wrong slug returns empty results and nothing is lost. Writes against a wrong slug corrupt data, so always confirm the slug first.",
      inputSchema: listRepositoriesInput,
    },
    async (args: ListRepositoriesArgs) => {
      try {
        const success = await postProduct(api, apiToken, "list-repositories", {
          limit: args.limit,
          offset: args.offset,
        });
        return textResult([success.result]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_query",
    {
      description:
        "Search project memories. Use this to recall facts, decisions, conventions, gotchas, and references recorded for a repository. Supports keyword (full-text) and semantic (embedding-based) search. This is a read-only tool — a wrong repository slug returns empty results; nothing is lost.",
      inputSchema: memoryQueryInput,
    },
    async (args: MemoryQueryArgs) => {
      try {
        const success = await postProduct(api, apiToken, "query", args);
        return textResult(success.result.results);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_get",
    {
      description:
        "Fetch a single memory by its numeric id from a repository's memory store. This is a read-only tool — a wrong repository slug returns 'No memory found'; nothing is lost.",
      inputSchema: memoryGetInput,
    },
    async (args: MemoryGetArgs) => {
      try {
        const success = await postProduct(api, apiToken, "get", args);
        return textResult([success.result]);
      } catch (cause) {
        return notFoundOrError(cause);
      }
    },
  );

  server.registerTool(
    "memory_list",
    {
      description:
        "List memories for a repository, optionally filtered by status, memory type, certainty, or tags. The response includes total_count and has_more; increase offset until has_more is false to inspect every match. This is a read-only tool — a wrong repository slug returns an empty list; nothing is lost.",
      inputSchema: memoryListInput,
    },
    async (args: MemoryListArgs) => {
      try {
        const success = await postProduct(api, apiToken, "list", args);
        return textResult([success.result]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_doctor",
    {
      description:
        "Audit active memories in one repository for exact and near duplicates, stale status overlap, canonical-topic overlap, missing status expiry, type-boundary problems, tag taxonomy issues, and malformed refs. This is read-only. Review every finding semantically before applying memory_deprecate or memory_update.",
      inputSchema: memoryDoctorInput,
    },
    async (args: MemoryDoctorArgs) => {
      try {
        const success = await postProduct(api, apiToken, "doctor", args);
        return textResult([success.result]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_stats",
    {
      description:
        "Summarize one repository's memory health and distribution: status, type, certainty, tags, oldest record, stale records, and untagged records. This is read-only; a wrong repository slug returns zero counts.",
      inputSchema: memoryStatsInput,
    },
    async (args: MemoryStatsArgs) => {
      try {
        const success = await postProduct(api, apiToken, "stats", args);
        return textResult([success.result]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_gc",
    {
      description:
        "Preview active status memories whose expires_after_days window has elapsed. This is always a read-only dry run: it returns expired rows and ids but never mutates them. Review the result, then explicitly deprecate or delete selected ids.",
      inputSchema: memoryGcInput,
    },
    async (args: MemoryGcArgs) => {
      try {
        const success = await postProduct(api, apiToken, "gc", args);
        return textResult([success.result]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_suggest",
    {
      description:
        "Suggest memories relevant to file paths, e.g. the files about to be edited. Ports the CLI suggest command: full-text search over path-derived terms plus directory neighborhood matches (tags and content/context path hints), merged and scored. Use this for the pre-edit scan when touched paths are known.",
      inputSchema: memorySuggestInput,
    },
    async (args: MemorySuggestArgs) => {
      try {
        const success = await postProduct(api, apiToken, "suggest", args);
        return textResult([success.result]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_verify",
    {
      description:
        "Verify an inferred fact against a stored memory. Ports the CLI verify command (Jaccard term similarity plus negation check): returns consistent or conflict with a similarity score. Re-read the memory with memory_get first when the inference may conflict.",
      inputSchema: memoryVerifyInput,
    },
    async (args: MemoryVerifyArgs) => {
      try {
        const success = await postProduct(api, apiToken, "verify", args);
        return textResult([success.result]);
      } catch (cause) {
        return notFoundOrError(cause);
      }
    },
  );

  server.registerTool(
    "memory_diff",
    {
      description:
        "Diff proposed new content against a stored memory. Ports the CLI diff command: returns whether the proposal conflicts plus similarity and added/removed terms. Use this before memory_update when wording must change and the inference may conflict.",
      inputSchema: memoryDiffInput,
    },
    async (args: MemoryDiffArgs) => {
      try {
        const success = await postProduct(api, apiToken, "diff", args);
        return textResult([success.result]);
      } catch (cause) {
        return notFoundOrError(cause);
      }
    },
  );

  server.registerTool(
    "memory_add",
    {
      description: `⚠️ WRITE OPERATION — a wrong repository slug will write to the wrong namespace. There is no default: repository is always required and must be an exact owner/name slug. Call list_repositories first if you are not certain.${ownerHint} Use this to record facts, decisions, conventions, gotchas, preferences, constraints, references, or status snapshots so future agent sessions can recall them. With upsert_match, a strong existing match is updated in place (echoes mode and upsert_match); a weak match refuses to create unless force is true. New records echo potential_conflicts so near-duplicates stay visible. Rejects on flight when the composed embedding text exceeds the 512 byte+2 budget (same as CLI size / Worker REST); call memory_size to preflight.`,
      inputSchema: memoryAddInput,
    },
    async (args: MemoryAddArgs) => {
      try {
        const success = await postProduct(api, apiToken, "add", args);
        return textResult([success.result]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_update",
    {
      description: `⚠️ WRITE OPERATION — a wrong repository slug will return not-found rather than silently corrupt data (the WHERE clause scopes by repository AND id). There is no default: repository is always required. Call list_repositories first if unsure.${ownerHint} Target by id, or by match (resolves the best active full-text match first; echoes it as matched). Only provided fields change. Re-embeds the vector so future semantic searches reflect the change. Rejects on flight when the resulting composed embedding text exceeds the 512 byte+2 budget; call memory_size to preflight.`,
      inputSchema: memoryUpdateInput,
    },
    async (args: MemoryUpdateArgs) => {
      try {
        const success = await postProduct(api, apiToken, "update", args);
        return textResult([success.result]);
      } catch (cause) {
        return notFoundOrError(cause);
      }
    },
  );

  server.registerTool(
    "memory_deprecate",
    {
      description: `⚠️ WRITE OPERATION — marks one to 100 explicit ids deprecated, or superseded_by when a canonical replacement id is supplied. There is no default: repository is always required. Call list_repositories first if unsure.${ownerHint} This preserves audit history and re-syncs each changed vector. Prefer this over permanent deletion for obsolete or replaced memories.`,
      inputSchema: memoryDeprecateInput,
    },
    async (args: MemoryDeprecateArgs) => {
      try {
        const success = await postProduct(api, apiToken, "deprecate", args);
        return textResult([success.result]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_size",
    {
      description:
        "Preflight the embedding budget for a prospective memory without writing. Uses the same conservative UTF-8 bytes+2 estimate the Worker enforces on every write (max 512). Mirrors CLI `machine-memory size` / add --dry-run size reporting. Call this before memory_add or memory_update when content may be long; oversize writes are rejected on flight.",
      inputSchema: memorySizeInput,
    },
    async (args: MemorySizeArgs) => {
      try {
        const success = await postProduct(api, apiToken, "size", args);
        if (!success.result.size.within_budget) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify([{ size: success.result.size }], null, 2),
              },
            ],
            isError: true,
          };
        }
        return textResult([{ size: success.result.size }]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_delete",
    {
      description: `⚠️ WRITE OPERATION — deletion is permanent. There is no default: repository is always required and must be an exact owner/name slug. Call list_repositories first if unsure.${ownerHint} Also removes the vector embedding.`,
      inputSchema: memoryDeleteInput,
    },
    async (args: MemoryDeleteArgs) => {
      try {
        const success = await postProduct(api, apiToken, "delete", args);
        return textResult([success.result]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_delete_many",
    {
      description: `⚠️ WRITE OPERATION — bulk deletion is permanent. Deletes one to 100 explicit ids from exactly one repository; there is no default and repository is always required. Call list_repositories first if unsure.${ownerHint} The response echoes deleted_from, deleted_ids, and not_found. Also removes vector embeddings. Prefer memory_deprecate when audit history should remain.`,
      inputSchema: memoryDeleteManyInput,
    },
    async (args: MemoryDeleteManyArgs) => {
      try {
        const success = await postProduct(api, apiToken, "delete-many", args);
        return textResult([success.result]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  return server;
}

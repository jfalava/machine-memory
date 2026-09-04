import {
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
} from "@machine-memory/contract";
import { McpServer } from "@modelcontextprotocol/server";
import pkg from "../../package.json";
import {
  measureMemoryEmbeddingBudget,
  ROW_SELECT,
  rowById,
  validateNamespace,
} from "./db";
import { compareMemoryFact } from "./facts";
import { runMemorySuggest } from "./suggest";
import {
  hybridSearch,
  keywordSearch,
  queryArgsToSearchInput,
  semanticSearch,
} from "./search";
import { errorResult, textMessage, textResult } from "./text";
import {
  listRepositoriesInput,
  memoryAddInput,
  memoryDeleteInput,
  memoryDiffInput,
  memoryGetInput,
  memoryListInput,
  memoryQueryInput,
  memorySizeInput,
  memorySuggestInput,
  memoryUpdateInput,
  memoryVerifyInput,
  type ListRepositoriesArgs,
  type MemoryAddArgs,
  type MemoryDeleteArgs,
  type MemoryDiffArgs,
  type MemoryGetArgs,
  type MemoryListArgs,
  type MemoryQueryArgs,
  type MemorySizeArgs,
  type MemorySuggestArgs,
  type MemoryUpdateArgs,
  type MemoryVerifyArgs,
} from "./tool-schemas";
import type { McpBindings, MemoryRow } from "./types";
import { applyMemoryUpdate, resolveUpdateTarget } from "./update";
import { addMemory, addMemoryUpsert } from "./write";

/** Same version as the monorepo CLI / package.json (not a separate MCP protocol number). */
export const MCP_SERVER_VERSION: string = pkg.version;

export function createMemoryServer(
  bindings: McpBindings,
  authenticatedLogin?: string,
): McpServer {
  const server = new McpServer({
    name: "machine-memory",
    version: MCP_SERVER_VERSION,
  });

  const ownerHint = authenticatedLogin
    ? ` The authenticated GitHub user is '${authenticatedLogin}', so repositories under that owner (e.g. '${authenticatedLogin}/repo-name') are likely candidates. Call list_repositories first if unsure.`
    : " Call list_repositories first if you are unsure which repository slug to use.";

  server.registerTool(
    "list_repositories",
    {
      description:
        "List all repository slugs (owner/name) that have at least one memory stored. Call this before any mutating tool (memory_add, memory_update, memory_delete) when you are not certain which repository slug to use. Reads (memory_query, memory_list, memory_get) can proceed loosely — a wrong slug returns empty results and nothing is lost. Writes against a wrong slug corrupt data, so always confirm the slug first.",
      inputSchema: listRepositoriesInput,
    },
    async (args: ListRepositoriesArgs) => {
      try {
        const limit = args.limit ?? SEARCH_LIMIT_MAX;
        const result = await bindings.DB.prepare(
          `SELECT DISTINCT repository FROM memories ORDER BY repository LIMIT ?`,
        )
          .bind(limit)
          .all<{ repository: string }>();
        const repos = (result.results ?? []).map((r) => r.repository);
        return textResult(repos);
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
        validateNamespace(args.repository);
        const mode = args.mode ?? "hybrid";
        const input = queryArgsToSearchInput(args, SEARCH_LIMIT_DEFAULT);
        if (mode === "keyword") {
          return textResult(await keywordSearch(bindings.DB, input));
        }
        if (mode === "semantic") {
          return textResult(await semanticSearch(bindings, input));
        }
        return textResult(await hybridSearch(bindings, input));
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
        validateNamespace(args.repository);
        const row = await rowById(bindings.DB, args.repository, args.id);
        if (!row) {
          return textMessage(
            `No memory found with id ${args.id} in repository '${args.repository}'.`,
          );
        }
        return textResult([row]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "memory_list",
    {
      description:
        "List memories for a repository, optionally filtered by status, memory type, or certainty. This is a read-only tool — a wrong repository slug returns an empty list; nothing is lost.",
      inputSchema: memoryListInput,
    },
    async (args: MemoryListArgs) => {
      try {
        validateNamespace(args.repository);
        const clauses = ["repository = ?"];
        const params: (string | number)[] = [args.repository];
        if (args.status !== undefined) {
          clauses.push("status = ?");
          params.push(args.status);
        }
        if (args.memory_type !== undefined) {
          clauses.push("memory_type = ?");
          params.push(args.memory_type);
        }
        if (args.certainty !== undefined) {
          clauses.push("certainty = ?");
          params.push(args.certainty);
        }
        if (args.tags !== undefined) {
          clauses.push("tags LIKE ?");
          params.push(`%${args.tags}%`);
        }
        const result = await bindings.DB.prepare(
          `SELECT ${ROW_SELECT}
           FROM memories WHERE ${clauses.join(" AND ")}
           ORDER BY updated_at DESC LIMIT ?`,
        )
          .bind(...params, args.limit ?? SEARCH_LIMIT_DEFAULT)
          .all<MemoryRow>();
        return textResult(result.results ?? []);
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
        return textResult([await runMemorySuggest(bindings.DB, args)]);
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
        validateNamespace(args.repository);
        const row = await rowById(bindings.DB, args.repository, args.id);
        if (!row) {
          return textMessage(
            `No memory found with id ${args.id} in repository '${args.repository}'.`,
          );
        }
        const result = compareMemoryFact(row.content, args.fact);
        return textResult([
          result.conflict
            ? {
                id: args.id,
                ok: false,
                result: "conflict",
                warning: "Conflict",
                similarity: result.similarity,
              }
            : {
                id: args.id,
                ok: true,
                result: "consistent",
                similarity: result.similarity,
              },
        ]);
      } catch (cause) {
        return errorResult(cause);
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
        validateNamespace(args.repository);
        const row = await rowById(bindings.DB, args.repository, args.id);
        if (!row) {
          return textMessage(
            `No memory found with id ${args.id} in repository '${args.repository}'.`,
          );
        }
        const result = compareMemoryFact(row.content, args.content);
        return textResult([
          {
            id: args.id,
            conflict: result.conflict,
            similarity: result.similarity,
            added_terms: result.addedTerms,
            removed_terms: result.removedTerms,
          },
        ]);
      } catch (cause) {
        return errorResult(cause);
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
        const upsertQuery = args.upsert_match?.trim() || undefined;
        if (upsertQuery === undefined) {
          return textResult([await addMemory(bindings, args)]);
        }
        return textResult([await addMemoryUpsert(bindings, args, upsertQuery)]);
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
        validateNamespace(args.repository);
        const target = await resolveUpdateTarget(
          bindings.DB,
          args.repository,
          args.id,
          args.match,
        );
        if (target.kind === "rejection") {
          return errorResult(new Error(target.message));
        }
        if (target.kind === "empty") {
          return textMessage(target.message);
        }
        return applyMemoryUpdate(bindings, args, target);
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
        const size = measureMemoryEmbeddingBudget({
          content: args.content,
          tags: args.tags ?? "",
          context: args.context ?? "",
          memory_type: args.memory_type ?? "convention",
          status: args.status ?? "active",
          certainty: args.certainty ?? "inferred",
        });
        if (!size.within_budget) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify([{ size }], null, 2),
              },
            ],
            isError: true,
          };
        }
        return textResult([{ size }]);
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
        validateNamespace(args.repository);
        const existing = await rowById(bindings.DB, args.repository, args.id);
        const result = await bindings.DB.prepare(
          "DELETE FROM memories WHERE repository = ? AND id = ?",
        )
          .bind(args.repository, args.id)
          .run();
        await bindings.VECTORIZE.deleteByIds([String(args.id)]).catch(
          (cause) => {
            console.error(
              `memory ${args.id} deleted but vector cleanup failed: ${String(cause)}`,
            );
          },
        );
        return textResult([
          {
            deleted_from: args.repository,
            id: args.id,
            deleted: (result.meta.changes ?? 0) > 0,
            existed: existing !== undefined,
          },
        ]);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  return server;
}

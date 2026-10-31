import {
  PRODUCT_OPERATIONS,
  type ProductRequest,
  type ProductResponse,
  type ProductRoute,
} from "@machine-memory/contract";
import { McpServer } from "@modelcontextprotocol/server";

import pkg from "../../package.json";
import {
  postProduct as postProductRequest,
  ProductApiError,
} from "./product-client";
import { mcpInputSchema } from "./schema-bridge";
import { errorResult, textMessage, textResult } from "./text";
import {
  MCP_SCOPES,
  type ErrorToolResult,
  type McpBindings,
  type McpScope,
  type TextToolResult,
} from "./types";

/** Same version as the monorepo CLI / package.json (not a separate MCP protocol number). */
const MCP_SERVER_VERSION: string = pkg.version;

const { read, write } = MCP_SCOPES;

/** Exhaustive classification: new product operations must choose a scope. */
const REQUIRED_SCOPES = {
  "list-repositories": read,
  query: read,
  get: read,
  history: read,
  list: read,
  doctor: read,
  stats: read,
  gc: read,
  suggest: read,
  verify: read,
  diff: read,
  size: read,
  add: write,
  update: write,
  restore: write,
  deprecate: write,
  delete: write,
  "delete-many": write,
} satisfies Record<ProductRoute, McpScope>;

type ToolResult = TextToolResult | ErrorToolResult;

/**
 * Map a product-route failure onto the MCP read-tool contract: the API's
 * 404 not-found messages pass through as plain text; everything else is a
 * tool error.
 */
function notFoundOrError(cause: unknown): ToolResult {
  if (cause instanceof ProductApiError && cause.status === 404) {
    return textMessage(cause.message);
  }
  return errorResult(cause);
}

/**
 * API-only gateway: every tool POSTs its (already MCP-validated) args to
 * the matching API `/product/*` route and returns the unwrapped contract
 * success result. D1/Vectorize/AI live only in the API worker.
 * Direct internal callers are trusted by default. Public OAuth entrypoints
 * MUST supply the effective token scopes, including an empty array.
 */
// oxlint-disable-next-line max-statements -- register the complete product tool surface
export function createMemoryServer(
  { api, apiToken }: McpBindings,
  authenticatedLogin?: string,
  scopes: readonly string[] | "trusted-internal" = "trusted-internal",
): McpServer {
  const server = new McpServer({
    name: "machine-memory",
    version: MCP_SERVER_VERSION,
  });

  // Authorization lives at execution time, before any API call. Advertising
  // scopes or tool descriptions alone does not restrict tools/call requests.
  async function postProduct<R extends ProductRoute>(
    route: R,
    body: ProductRequest<NoInfer<R>>,
  ): Promise<ProductResponse<R>> {
    const required = REQUIRED_SCOPES[route];
    if (scopes !== "trusted-internal" && !scopes.includes(required)) {
      throw new ProductApiError(
        403,
        `Insufficient scope: ${required} required.`,
      );
    }
    return postProductRequest(api, apiToken, route, body);
  }

  /** Register a tool that returns the product route's result as `[result]`. */
  function register<R extends ProductRoute>(
    name: string,
    route: R,
    description: string,
    onError: (cause: unknown) => ToolResult = errorResult,
  ): void {
    server.registerTool(
      name,
      {
        description,
        inputSchema: mcpInputSchema(PRODUCT_OPERATIONS[route].request),
      },
      async (args: ProductRequest<R>) => {
        try {
          const success = await postProduct(route, args);
          return textResult([success.result]);
        } catch (cause) {
          return onError(cause);
        }
      },
    );
  }

  const ownerHint = authenticatedLogin
    ? ` The authenticated GitHub user is '${authenticatedLogin}', so repositories under that owner (e.g. '${authenticatedLogin}/repo-name') are likely candidates. Call list_repositories first if unsure.`
    : " Call list_repositories first if you are unsure which repository slug to use.";

  register(
    "list_repositories",
    "list-repositories",
    "List repository slugs (owner/name) with total, active, deprecated, and superseded counts. The response includes pagination metadata; use offset while has_more is true. Call this before any mutating tool when you are not certain which repository slug to use. Reads can proceed loosely — a wrong slug returns empty results and nothing is lost. Writes against a wrong slug corrupt data, so always confirm the slug first.",
  );

  register(
    "memory_query",
    "query",
    "Search project memories. Use this to recall facts, decisions, conventions, gotchas, and references recorded for a repository. Supports keyword (full-text), semantic (embedding-based), and hybrid search. Returns { count, no_strong_match, results }; each result has an absolute match_strength (strong, weak, none) and the query identifiers it matched exactly. Scores only rank within one response: when no_strong_match is true, treat results as loosely related candidates. This is a read-only tool — a wrong repository slug returns empty results; nothing is lost.",
  );

  register(
    "memory_get",
    "get",
    "Fetch a single memory by its numeric id from a repository's memory store. This is a read-only tool — a wrong repository slug returns 'No memory found'; nothing is lost.",
    notFoundOrError,
  );

  register(
    "memory_list",
    "list",
    "List memories for a repository, optionally filtered by status, memory type, certainty, or tags. The response includes total_count and has_more; increase offset until has_more is false to inspect every match. This is a read-only tool — a wrong repository slug returns an empty list; nothing is lost.",
  );

  register(
    "memory_history",
    "history",
    "List complete previous snapshots for one memory, newest first. Use this after an accidental or suspicious update; the current_update_count in the response is required by memory_restore to prevent overwriting a newer change.",
  );

  register(
    "memory_doctor",
    "doctor",
    "Audit active memories in one repository for exact and near duplicates, stale status overlap, canonical-topic overlap, missing status expiry, type-boundary problems, tag taxonomy issues, malformed refs, verified records without evidence (verified_without_evidence: legacy rows to review, not bulk-fix), and gotchas naming the same identifiers (gotcha_overlap: consolidate the shared workaround). This is read-only. Review every finding semantically before applying memory_deprecate or memory_update.",
  );

  register(
    "memory_stats",
    "stats",
    "Summarize one repository's memory health and distribution: status, type, certainty, tags, oldest record, stale records, and untagged records. This is read-only; a wrong repository slug returns zero counts.",
  );

  register(
    "memory_gc",
    "gc",
    "Preview active status memories whose expires_after_days window has elapsed. This is always a read-only dry run: it returns expired rows and ids but never mutates them. Review the result, then explicitly deprecate or delete selected ids.",
  );

  register(
    "memory_suggest",
    "suggest",
    "Suggest memories relevant to file paths, e.g. the files about to be edited. Combines full-text search over path-derived terms with directory neighborhood matches (tags and content/context path hints), merged and scored. Results are strong only when a memory names a suggested file path or specific file name literally; no_strong_match is true otherwise. Use this for the pre-edit scan when touched paths are known.",
  );

  register(
    "memory_verify",
    "verify",
    "Verify an inferred fact against a stored memory using term similarity (Jaccard) plus a negation check: returns consistent or conflict with a similarity score. Re-read the memory with memory_get first when the inference may conflict.",
    notFoundOrError,
  );

  register(
    "memory_diff",
    "diff",
    "Diff proposed new content against a stored memory: returns whether the proposal conflicts plus similarity, added/removed terms, and dropped: identifiers and sentences of the stored content that the proposal no longer carries. Use this before memory_update when wording must change and the inference may conflict.",
    notFoundOrError,
  );

  register(
    "memory_add",
    "add",
    `⚠️ WRITE OPERATION — a wrong repository slug will write to the wrong namespace. There is no default: repository is always required and must be an exact owner/name slug. Call list_repositories first if you are not certain.${ownerHint} Use this to record facts, decisions, conventions, gotchas, preferences, constraints, references, or status snapshots so future agent sessions can recall them. With upsert_match, a strong existing match is updated in place (echoes mode and upsert_match); a weak match refuses to create unless force is true. New records echo potential_conflicts so near-duplicates stay visible. certainty verified requires a non-empty evidence array naming what was established (user_requirement, observed_implementation, verified_mechanism, tested_behavior); record remaining limits in validation_gaps. evidence and validation_gaps are not embedded. Rejects the write when the composed embedding text exceeds the 512 byte+2 budget; call memory_size to preflight.`,
  );

  register(
    "memory_update",
    "update",
    `⚠️ WRITE OPERATION — a wrong repository slug will return not-found rather than silently corrupt data (the WHERE clause scopes by repository AND id). There is no default: repository is always required. Call list_repositories first if unsure.${ownerHint} Target by id, or by match (resolves the best active full-text match first; echoes it as matched). Only provided fields change. A content or status change returns dropped (identifiers and sentences the new content lost) and review_candidates (other active records that may rely on the old premise); resolve both. evidence and validation_gaps replace the stored arrays when given ([] clears). Setting certainty verified, or clearing evidence on a verified record, requires a non-empty evidence array. Commits the row and queues vector indexing together; semantic search catches up asynchronously. Rejects active memories when the resulting composed embedding text exceeds the 512 byte+2 budget; call memory_size to preflight.`,
    notFoundOrError,
  );

  register(
    "memory_deprecate",
    "deprecate",
    `⚠️ WRITE OPERATION — marks one to 100 explicit ids deprecated, or superseded_by when a canonical replacement id is supplied. There is no default: repository is always required. Call list_repositories first if unsure.${ownerHint} This preserves audit history and re-syncs each changed vector. Returns review_candidates when other active records may rely on the retired premise; resolve each one. Prefer this over permanent deletion for obsolete or replaced memories.`,
  );

  register(
    "memory_restore",
    "restore",
    `⚠️ WRITE OPERATION — restores one complete historical snapshot in place, preserving the memory id and re-queueing its current vector. Call memory_history first, then pass its revision_id and the current_update_count. A stale count returns a conflict instead of overwriting a newer update.${ownerHint}`,
    notFoundOrError,
  );

  server.registerTool(
    "memory_size",
    {
      description:
        "Preflight the embedding budget for a prospective memory without writing. Uses the same conservative UTF-8 bytes+2 estimate enforced on every write (max 512). Call this before memory_add or memory_update when content may be long; oversize writes are rejected.",
      inputSchema: mcpInputSchema(PRODUCT_OPERATIONS.size.request),
    },
    async (args: ProductRequest<"size">) => {
      try {
        const { size } = (await postProduct("size", args)).result;
        return size.within_budget
          ? textResult([{ size }])
          : { ...textResult([{ size }]), isError: true as const };
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  register(
    "memory_delete",
    "delete",
    `⚠️ WRITE OPERATION — deletion is permanent. There is no default: repository is always required and must be an exact owner/name slug. Call list_repositories first if unsure.${ownerHint} Also removes the vector embedding.`,
  );

  register(
    "memory_delete_many",
    "delete-many",
    `⚠️ WRITE OPERATION — bulk deletion is permanent. Deletes one to 100 explicit ids from exactly one repository; there is no default and repository is always required. Call list_repositories first if unsure.${ownerHint} The response echoes deleted_from, deleted_ids, and not_found. Also removes vector embeddings. Prefer memory_deprecate when audit history should remain.`,
  );

  return server;
}

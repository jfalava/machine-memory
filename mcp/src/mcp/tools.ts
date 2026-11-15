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
  "tag-map-list": read,
  coverage: read,
  "tag-map-set": write,
  "tag-map-delete": write,
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

  // The API cannot see who holds the token, so writes are attributed here.
  const writer = authenticatedLogin ? `mcp:${authenticatedLogin}` : "mcp";
  function attributed<T extends { readonly source_agent?: string }>(
    args: T,
  ): T {
    return { ...args, source_agent: args.source_agent?.trim() || writer };
  }

  /** Register a tool that returns the product route's result as `[result]`. */
  function register<R extends ProductRoute>(
    name: string,
    route: R,
    description: string,
    onError: (cause: unknown) => ToolResult = errorResult,
    prepare: (args: ProductRequest<R>) => ProductRequest<R> = (args) => args,
  ): void {
    server.registerTool(
      name,
      {
        description,
        inputSchema: mcpInputSchema(PRODUCT_OPERATIONS[route].request),
      },
      async (args: ProductRequest<R>) => {
        try {
          const success = await postProduct(route, prepare(args));
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
    "Search project memories. Use this to recall facts, decisions, conventions, gotchas, and references recorded for a repository. Supports keyword (full-text), semantic (embedding-based), and hybrid search. Returns { repository, count, no_strong_match, results }; each result has an absolute match_strength (strong, weak, none), the query identifiers it matched exactly, and matched_terms with matched_in, the fields that hold them. Scores only rank within one response: when no_strong_match is true, treat results as loosely related candidates. A status memory past its expiry is left out unless memory_type is status; memory_list and memory_get still return it. This is a read-only tool — a wrong repository slug returns empty results; nothing is lost.",
  );

  register(
    "memory_get",
    "get",
    "Fetch one to 100 memories in full by their numeric ids, such as ids [12, 40]. Returns { repository, count, results }, with results in the order the ids were given. An id the repository does not hold is listed in missing_ids instead of failing the call, and found_elsewhere names the repository that does hold it, so a wrong repository slug shows up as count 0. This is a read-only tool.",
  );

  register(
    "memory_list",
    "list",
    "List memories for a repository, optionally filtered by status, memory type, certainty, or tags. Returns { repository, count, total_count, offset, limit, has_more, results }; increase offset until has_more is false to inspect every match. This is a read-only tool — a wrong repository slug returns an empty list; nothing is lost.",
  );

  register(
    "memory_history",
    "history",
    "List complete previous snapshots for one memory, newest first. Use this after an accidental or suspicious update; the current_update_count in the response is required by memory_restore to prevent overwriting a newer change.",
  );

  register(
    "memory_doctor",
    "doctor",
    "Audit active memories in one repository for exact and near duplicates, a status superseded by a newer status on the same topic tag (stale_status_overlap), missing status expiry, status records past their expiry (expired_status: update or deprecate them), type-boundary problems, tag taxonomy issues, malformed refs, verified records without evidence (verified_without_evidence: legacy rows to review, not bulk-fix), and gotchas naming the same identifiers (gotcha_overlap: consolidate the shared workaround). Two kinds are informational and need no fix on their own: canonical_thread_overlap (several records on one topic) and similar_tags (tags such as topic:og and topic:og-image that may name one topic). counts_by_kind gives the size of each kind. unindexed counts the active records semantic search cannot find because their vector predates the current index; the CLI command reindex --unindexed queues them. This is read-only. Review every finding semantically before applying memory_deprecate or memory_update.",
  );

  register(
    "memory_stats",
    "stats",
    "Summarize one repository's memory health and distribution: status, type, certainty, tags, oldest record, stale records, and untagged records. The index field reports the semantic index: records pending (written, not indexed yet), retrying (last index write failed and will be tried again), and parked (cannot be indexed until the record changes), plus failures grouped by error, and unindexed (active records whose vector predates the current index; the CLI command reindex --unindexed queues them); semantic search can miss records until all four are 0. This is read-only; a wrong repository slug returns zero counts.",
  );

  register(
    "memory_gc",
    "gc",
    "Preview active status memories whose expires_after_days window has elapsed. This is always a read-only dry run: it returns expired rows and ids but never mutates them. Review the result, then explicitly deprecate or delete selected ids.",
  );

  register(
    "memory_suggest",
    "suggest",
    "Suggest memories relevant to file paths, e.g. the files about to be edited. Combines full-text search over path-derived terms with directory neighborhood matches (tags and content/context path hints), merged and scored. Results are strong only when a memory names a suggested file path or specific file name literally; no_strong_match is true otherwise. Manifests and lockfiles (package.json, bunfig.toml, *.lock) are searched by directory, not by name, and are listed in generic_files; use memory_query to find a memory about one. Use this for the pre-edit scan when touched paths are known.",
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
    `⚠️ WRITE OPERATION — a wrong repository slug will write to the wrong namespace. There is no default: repository is always required and must be an exact owner/name slug. Call list_repositories first if you are not certain.${ownerHint} Use this to record facts, decisions, conventions, gotchas, preferences, constraints, references, or status snapshots so future agent sessions can recall them. A plain add is refused when an active memory already states nearly the same thing; the error names that memory. To restate an existing memory, pass update_id with its id: the content is replaced and the fields you omit keep their stored values. When you have read the existing memories and this is a different fact, pass create_new true. Pass paths with the files the memory is about to add the tags of the repository's tag map (tag_map_list shows it); the result lists them in path_tag_matches. upsert_match resolves the target by topic instead: a strong match is updated in place (echoes mode and upsert_match), and a weak match is refused with up to three candidates, each with rank_score, text_overlap and shared_identifiers. Replacing content is refused when it drops a path, flag or symbol that no other active memory mentions; carry the detail over, or pass allow_drop true when it is obsolete. A new memory echoes related, the active memories that strongly match it, when there are any. certainty verified requires a non-empty evidence array naming what was established (user_requirement, observed_implementation, verified_mechanism, tested_behavior); record remaining limits in validation_gaps. evidence and validation_gaps are not embedded. Refuses a memory whose content, tags and context together exceed 2,000 UTF-8 bytes; call memory_size to preflight.`,
    errorResult,
    attributed,
  );

  register(
    "memory_update",
    "update",
    `⚠️ WRITE OPERATION — a wrong repository slug will return not-found rather than silently corrupt data (the WHERE clause scopes by repository AND id). There is no default: repository is always required. Call list_repositories first if unsure.${ownerHint} Target by id, or by match (resolves the best active full-text match first; echoes it as matched). Only provided fields change, so omit content to change only metadata. content replaces the whole stored content; the update is refused when it drops a path, flag or symbol that no other active memory mentions, or shares almost nothing with the stored content. The error names what would be lost: carry it over, add a new memory instead when this is a different fact, or pass allow_drop true when the detail is obsolete. A content or status change returns dropped (identifiers and sentences the new content lost) and review_candidates (other active records that may rely on the old premise); resolve both. To change some tags or gaps, use add_tags, remove_tags, add_validation_gaps and remove_validation_gaps; tags, evidence and validation_gaps replace the stored values when given ([] clears). Setting certainty verified, or clearing evidence on a verified record, requires a non-empty evidence array. Commits the row and queues vector indexing together; semantic search catches up asynchronously. Refuses an active memory whose resulting content, tags and context together exceed 2,000 UTF-8 bytes; call memory_size to preflight.`,
    notFoundOrError,
    attributed,
  );

  register(
    "memory_deprecate",
    "deprecate",
    `⚠️ WRITE OPERATION — marks one to 100 explicit ids deprecated, or superseded_by when a canonical replacement id is supplied. There is no default: repository is always required. Call list_repositories first if unsure.${ownerHint} This preserves audit history and re-syncs each changed vector. Returns review_candidates when other active records may rely on the retired premise; resolve each one. Prefer this over permanent deletion for obsolete or replaced memories.`,
    errorResult,
    attributed,
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
        "Measures a prospective memory against the 2,000-byte limit without writing. The limit counts the UTF-8 bytes of content, tags, and context together. Returns bytes, remaining_bytes, over_by_bytes, and the bytes each field uses; an over-limit report comes back as a tool error. memory_add and memory_update refuse a memory over the limit, so call this first when the content may be long.",
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

  register(
    "tag_map_list",
    "tag-map-list",
    "List the repository's tag map: path prefixes and the tags that memory_add gives a memory when its paths fall under them. Pass paths to see the tags a set of files would get, the prefix each one matched (matches), and the paths no prefix matched (unmatched_paths). A repository without mappings returns an empty list. This is read-only.",
  );

  register(
    "tag_map_set",
    "tag-map-set",
    `⚠️ WRITE OPERATION — sets the tags of one path prefix in the repository's tag map, replacing the tags that prefix had. A prefix matches the path itself and everything under it, so src/cli covers src/cli/app.ts. Use it when memories about one directory should share tags, such as area:cli for src/cli; memory_add then adds them to every memory whose paths fall under the prefix. Memories that already exist keep their tags.${ownerHint}`,
  );

  register(
    "tag_map_delete",
    "tag-map-delete",
    "⚠️ WRITE OPERATION — removes one path prefix from the repository's tag map. The response reports status deleted, or not_found when the map has no such prefix. Memories tagged through the prefix keep their tags.",
  );

  register(
    "memory_coverage",
    "coverage",
    "Find directories that no active memory is tagged for. Pass the directory paths of the checkout, relative to the repository root. A directory is covered when one of its path segments equals a tag of an active memory, compared in lower case. Returns uncovered_paths and tag_distribution, the number of active memories per tag. Treat the result as a hint about where memories may be missing, not as a score. This is read-only.",
  );

  return server;
}

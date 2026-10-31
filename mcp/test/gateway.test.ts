import {
  decodeRequest,
  encodeResponse,
  type JsonValue,
  type MemoryRow,
  PRODUCT_OPERATIONS,
  productRoutePath,
  type ProductRoute,
} from "@machine-memory/contract";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import * as Schema from "effect/Schema";
import { describe, expect, test } from "vitest";

import { type ApiFetcher, postProduct } from "../src/mcp/product-client";
import { createMemoryServer } from "../src/mcp/tools";

type SeenCall = {
  url: string;
  authorization: string | undefined;
  body: JsonValue;
};

const decodeJsonBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Json),
);

type StubRoute = {
  status: number;
  body: unknown;
  raw?: string;
};

function stubApi(
  routes: Record<string, StubRoute>,
  seen: SeenCall[],
): ApiFetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const headers = new Headers(init?.headers);
      const text = await new Response(init?.body).text();
      const body = decodeJsonBody(text === "" ? "{}" : text);
      seen.push({
        url,
        authorization: headers.get("authorization") ?? undefined,
        body,
      });
      const path = new URL(url).pathname;
      const hit = routes[path];
      if (hit === undefined) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
        });
      }
      if (hit.raw !== undefined) {
        return new Response(hit.raw, { status: hit.status });
      }
      return new Response(JSON.stringify(hit.body), { status: hit.status });
    },
  };
}

const ROW = {
  id: 7,
  repository: "o/r",
  content: "deploy with bun run deploy",
  tags: "area:docs",
  context: "",
  memory_type: "decision",
  status: "active",
  certainty: "verified",
  evidence: ["observed_implementation"],
  validation_gaps: [],
} as const;

const SCORED_ROW = {
  ...ROW,
  match_strength: "strong",
  term_coverage: 1,
  exact_matches: [],
};

const FULL_ROW = {
  ...ROW,
  superseded_by: 12,
  source_agent: "codex",
  last_updated_by: "mcp",
  update_count: 3,
  refs: ["docs/deploy.md"],
  expires_after_days: 7,
  created_at: "2026-09-01 10:00:00",
  updated_at: "2026-09-05 12:00:00",
} satisfies MemoryRow;

const SIZE = {
  source: "bytes",
  bytes_estimate: 100,
  max_bytes_estimate: 512,
  within_budget: true,
  binding_limit: null,
  over_by_bytes: 0,
  remaining: 412,
  limits: { bytes_estimate: { value: 100, limit: 512, pass: true } },
};

const WRITE = { written_to: "o/r", id: 7, memory: FULL_ROW, size: SIZE };

/** [tool, route, MCP arguments, route result the tool returns as [result]]. */
const PASS_THROUGH_CASES: ReadonlyArray<
  readonly [string, ProductRoute, Readonly<Record<string, JsonValue>>, unknown]
> = [
  [
    "list_repositories",
    "list-repositories",
    { limit: 1, offset: 1 },
    {
      repositories: [
        { slug: "o/r", total: 9, active: 5, deprecated: 2, superseded: 2 },
      ],
      count: 1,
      total_count: 3,
      offset: 1,
      limit: 1,
      has_more: true,
    },
  ],
  [
    "memory_query",
    "query",
    { repository: "o/r", query: "deploy" },
    {
      count: 1,
      no_strong_match: false,
      results: [{ ...SCORED_ROW, score: 12.5 }],
    },
  ],
  ["memory_get", "get", { repository: "o/r", id: 7 }, FULL_ROW],
  [
    "memory_list",
    "list",
    { repository: "o/r", limit: 1, offset: 50 },
    {
      count: 1,
      total_count: 53,
      offset: 50,
      limit: 1,
      has_more: true,
      results: [FULL_ROW],
    },
  ],
  [
    "memory_history",
    "history",
    { repository: "o/r", id: 7, limit: 1, offset: 2 },
    {
      repository: "o/r",
      id: 7,
      current_update_count: 3,
      count: 1,
      total_count: 3,
      offset: 2,
      limit: 1,
      has_more: false,
      results: [
        {
          ...FULL_ROW,
          revision_id: 11,
          snapshot_at: "2026-09-05 12:00:00",
          operation: "update",
        },
      ],
    },
  ],
  [
    "memory_doctor",
    "doctor",
    { repository: "o/r" },
    {
      repository: "o/r",
      checked: 2,
      count: 1,
      findings: [
        {
          kind: "exact_duplicate",
          ids: [7, 8],
          details: { keep_id: 7, duplicate_ids: [8] },
        },
      ],
      counts_by_kind: { exact_duplicate: 1 },
    },
  ],
  [
    "memory_stats",
    "stats",
    { repository: "o/r" },
    {
      repository: "o/r",
      total_memories: 2,
      active: 1,
      deprecated: 1,
      superseded: 0,
      breakdown_by_memory_type: { decision: 2 },
      breakdown_by_certainty: { verified: 2 },
      tag_frequency_map: { "area:docs": 2 },
      oldest_memory: { id: 7, created_at: FULL_ROW.created_at },
      memories_not_updated_over_90_days: 0,
      memories_with_no_tags: 0,
    },
  ],
  [
    "memory_gc",
    "gc",
    { repository: "o/r" },
    {
      repository: "o/r",
      dry_run: true,
      count: 1,
      ids: [7],
      expired: [FULL_ROW],
    },
  ],
  [
    "memory_suggest",
    "suggest",
    { repository: "o/r", files: "src/index.ts" },
    {
      files: ["src/index.ts"],
      normalized_path_terms: ["src", "index"],
      derived_terms: ["index"],
      neighborhood: { tags: ["area:src"], paths: ["src"] },
      count: 1,
      no_strong_match: false,
      results: [{ ...SCORED_ROW, score: 3 }],
    },
  ],
  [
    "memory_verify",
    "verify",
    { repository: "o/r", id: 7, fact: "deploy with bun" },
    { id: 7, ok: true, result: "consistent", similarity: 0.8 },
  ],
  [
    "memory_diff",
    "diff",
    { repository: "o/r", id: 7, content: "deploy with npm" },
    {
      id: 7,
      conflict: false,
      similarity: 0.6,
      added_terms: ["npm"],
      removed_terms: ["bun"],
      dropped: { identifiers: [], sentences: [] },
    },
  ],
  ["memory_size", "size", { content: "fact" }, { size: SIZE }],
  ["memory_add", "add", { repository: "o/r", content: "new fact" }, WRITE],
  [
    "memory_update",
    "update",
    { repository: "o/r", match: "deploy", content: "deploy updated" },
    { ...WRITE, matched: { query: "deploy", id: 7, score: 42.5 } },
  ],
  [
    "memory_restore",
    "restore",
    { repository: "o/r", id: 7, revision_id: 11, expected_update_count: 3 },
    {
      written_to: "o/r",
      id: 7,
      restored_revision_id: 11,
      memory: FULL_ROW,
      size: SIZE,
    },
  ],
  [
    "memory_deprecate",
    "deprecate",
    { repository: "o/r", ids: [7, 99], superseded_by: 12 },
    {
      written_to: "o/r",
      status: "superseded_by",
      superseded_by: 12,
      requested_ids: [7, 99],
      deprecated: [{ ...FULL_ROW, status: "superseded_by", superseded_by: 12 }],
      not_found: [99],
      count: 1,
    },
  ],
  [
    "memory_delete",
    "delete",
    { repository: "o/r", id: 7 },
    { deleted_from: "o/r", id: 7, deleted: true, existed: true },
  ],
  [
    "memory_delete_many",
    "delete-many",
    { repository: "o/r", ids: [7, 99] },
    {
      deleted_from: "o/r",
      requested_ids: [7, 99],
      deleted_ids: [7],
      not_found: [99],
      count: 1,
    },
  ],
];

async function linkedClient(
  bindings: { api: ApiFetcher; apiToken: string },
  scopes: readonly string[] | "trusted-internal" = "trusted-internal",
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMemoryServer(bindings, undefined, scopes);
  await server.connect(serverTransport);
  const client = new Client({ name: "gateway-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function firstText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const block = result.content[0];
  if (block?.type !== "text" || block.text === undefined) {
    throw new Error("expected a text content block");
  }
  return block.text;
}

describe("mcp gateway to api product routes", () => {
  test("pass-through cases cover every product route", () => {
    expect(new Set(PASS_THROUGH_CASES.map(([, route]) => route))).toEqual(
      new Set(Object.keys(PRODUCT_OPERATIONS)),
    );
  });

  test.each(PASS_THROUGH_CASES)(
    "%s posts to /product/%s with the bearer token and returns [result]",
    async (name, route, args, routeResult) => {
      const seen: SeenCall[] = [];
      const client = await linkedClient({
        api: stubApi(
          {
            [productRoutePath(route)]: {
              status: 200,
              body: { ok: true, result: routeResult },
            },
          },
          seen,
        ),
        apiToken: "test-token",
      });
      try {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBeFalsy();
        expect(JSON.parse(firstText(result))).toEqual([routeResult]);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.url).toBe(
          `https://product.internal${productRoutePath(route)}`,
        );
        expect(seen[0]?.authorization).toBe("Bearer test-token");
        expect(seen[0]?.body).toEqual(args);
      } finally {
        await client.close();
      }
    },
  );

  test.each([
    ["memory_add", { repository: "o/r", content: "new fact" }],
    ["memory_update", { repository: "o/r", id: 7, content: "updated fact" }],
    [
      "memory_restore",
      { repository: "o/r", id: 7, revision_id: 11, expected_update_count: 3 },
    ],
    ["memory_deprecate", { repository: "o/r", ids: [7] }],
    ["memory_delete", { repository: "o/r", id: 7 }],
    ["memory_delete_many", { repository: "o/r", ids: [7] }],
  ])("read scope denies %s without an API call", async (name, args) => {
    const seen: SeenCall[] = [];
    const client = await linkedClient(
      { api: stubApi({}, seen), apiToken: "test-token" },
      ["mcp:read"],
    );
    try {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("mcp:write required");
      expect(seen).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test.each([
    ["list_repositories", {}],
    ["memory_query", { repository: "o/r", query: "fact" }],
    ["memory_get", { repository: "o/r", id: 7 }],
    ["memory_history", { repository: "o/r", id: 7 }],
    ["memory_list", { repository: "o/r" }],
    ["memory_doctor", { repository: "o/r" }],
    ["memory_stats", { repository: "o/r" }],
    ["memory_gc", { repository: "o/r" }],
    ["memory_suggest", { repository: "o/r", files: "src/index.ts" }],
    ["memory_verify", { repository: "o/r", id: 7, fact: "fact" }],
    ["memory_diff", { repository: "o/r", id: 7, content: "fact" }],
    ["memory_size", { repository: "o/r", content: "fact" }],
  ])("%s requires read scope even with write scope", async (name, args) => {
    for (const scopes of [[], ["mcp:write"]]) {
      const seen: SeenCall[] = [];
      const client = await linkedClient(
        { api: stubApi({}, seen), apiToken: "test-token" },
        scopes,
      );
      try {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(firstText(result)).toContain("mcp:read required");
        expect(seen).toEqual([]);
      } finally {
        await client.close();
      }
    }
  });

  test("memory_get carries all metadata through the encoded API response", async () => {
    const client = await linkedClient({
      api: stubApi(
        {
          "/product/get": {
            status: 200,
            body: encodeResponse(PRODUCT_OPERATIONS.get.response, {
              ok: true,
              result: FULL_ROW,
            }),
          },
        },
        [],
      ),
      apiToken: "test-token",
    });
    const result = await client.callTool({
      name: "memory_get",
      arguments: { repository: "o/r", id: 7 },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual([FULL_ROW]);
  });

  test("memory_restore surfaces a stale revision conflict instead of reporting success", async () => {
    const client = await linkedClient({
      api: stubApi(
        {
          "/product/restore": {
            status: 409,
            body: { ok: false, error: "Memory changed concurrently; retry." },
          },
        },
        [],
      ),
      apiToken: "test-token",
    });
    try {
      const result = await client.callTool({
        name: "memory_restore",
        arguments: {
          repository: "o/r",
          id: 7,
          revision_id: 11,
          expected_update_count: 3,
        },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("Memory changed concurrently");
    } finally {
      await client.close();
    }
  });

  test.each(["x".repeat(65), "é".repeat(33)])(
    "MCP and API reject oversized namespaces before fetching: %s",
    async (repository) => {
      const seen: SeenCall[] = [];
      const args = { repository, id: 7 };
      expect(decodeRequest(PRODUCT_OPERATIONS.get.request, args).ok).toBe(
        false,
      );
      const client = await linkedClient({
        api: stubApi({}, seen),
        apiToken: "test-token",
      });
      const result = await client.callTool({
        name: "memory_get",
        arguments: args,
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("64 UTF-8 bytes");
      expect(seen).toHaveLength(0);
    },
  );

  test("tool discovery preserves shared field descriptions and constraints", async () => {
    const client = await linkedClient({
      api: stubApi({}, []),
      apiToken: "test-token",
    });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(Object.keys(PRODUCT_OPERATIONS).length);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "memory_doctor",
        "memory_stats",
        "memory_gc",
        "memory_deprecate",
        "memory_delete_many",
      ]),
    );
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["memory_migrate", "memory_import"]),
    );
    const get = tools.find((tool) => tool.name === "memory_get");
    expect(JSON.stringify(get?.inputSchema)).toContain("64 UTF-8 bytes");
    const add = tools.find((tool) => tool.name === "memory_add");
    expect(JSON.stringify(add?.inputSchema)).toContain("weak match refuses");
    const deleteMany = tools.find((tool) => tool.name === "memory_delete_many");
    expect(deleteMany?.description).toContain("deletion is permanent");
  });

  test("the route selects its response schema and rejects a different operation result", async () => {
    const api = stubApi(
      {
        "/product/get": {
          status: 200,
          body: {
            ok: true,
            result: {
              deleted_from: "o/r",
              id: 7,
              deleted: true,
              existed: true,
            },
          },
        },
      },
      [],
    );
    await expect(
      postProduct(api, "token", "get", { repository: "o/r", id: 7 }),
    ).rejects.toThrow("invalid response");
  });

  test("memory_query preserves actionable API query guidance for the agent", async () => {
    const guidance =
      "Full-text query could not be parsed. Use simpler words and remove FTS punctuation or operators.";
    const client = await linkedClient({
      api: stubApi(
        {
          "/product/query": {
            status: 400,
            body: { ok: false, error: guidance },
          },
        },
        [],
      ),
      apiToken: "test-token",
    });
    const result = await client.callTool({
      name: "memory_query",
      arguments: { repository: "o/r", query: "botched*query" },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe(guidance);
  });

  test("memory_get maps 404 to a plain not-found message", async () => {
    const seen: SeenCall[] = [];
    const client = await linkedClient({
      api: stubApi(
        {
          "/product/get": {
            status: 404,
            body: {
              ok: false,
              error: "No memory found with id 9 in repository 'o/r'.",
            },
          },
        },
        seen,
      ),
      apiToken: "test-token",
    });
    const result = await client.callTool({
      name: "memory_get",
      arguments: { repository: "o/r", id: 9 },
    });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain("No memory found with id 9");
  });

  test("memory_add maps 400 upsert refusal to a tool error", async () => {
    const seen: SeenCall[] = [];
    const client = await linkedClient({
      api: stubApi(
        {
          "/product/add": {
            status: 400,
            body: {
              ok: false,
              error: "Best match #3 is not a strong upsert match",
            },
          },
        },
        seen,
      ),
      apiToken: "test-token",
    });
    const result = await client.callTool({
      name: "memory_add",
      arguments: {
        repository: "o/r",
        content: "something new",
        upsert_match: "something",
      },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("not a strong upsert match");
  });

  test("memory_size surfaces over-budget as a tool error with the report", async () => {
    const size = {
      ...SIZE,
      bytes_estimate: 600,
      within_budget: false,
      binding_limit: "bytes",
      over_by_bytes: 88,
      remaining: -88,
      limits: { bytes_estimate: { value: 600, limit: 512, pass: false } },
    };
    const seen: SeenCall[] = [];
    const client = await linkedClient({
      api: stubApi(
        {
          "/product/size": {
            status: 200,
            body: { ok: true, result: { size } },
          },
        },
        seen,
      ),
      apiToken: "test-token",
    });
    const result = await client.callTool({
      name: "memory_size",
      arguments: { repository: "o/r", content: "x".repeat(600) },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result))).toEqual([{ size }]);
  });

  test("bearer-shaped 401 without ok flag maps to a tool error", async () => {
    const seen: SeenCall[] = [];
    const client = await linkedClient({
      api: stubApi(
        { "/product/delete": { status: 401, body: { error: "Unauthorized" } } },
        seen,
      ),
      apiToken: "bad-token",
    });
    const result = await client.callTool({
      name: "memory_delete",
      arguments: { repository: "o/r", id: 7 },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Unauthorized");
  });

  test("non-JSON api body maps to a tool error", async () => {
    const seen: SeenCall[] = [];
    const client = await linkedClient({
      api: stubApi(
        {
          "/product/list": {
            status: 500,
            body: null,
            raw: "<html>boom</html>",
          },
        },
        seen,
      ),
      apiToken: "test-token",
    });
    const result = await client.callTool({
      name: "memory_list",
      arguments: { repository: "o/r" },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("non-JSON");
  });
});

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, test } from "vitest";
import { createMemoryServer } from "../src/mcp";
import type { ApiFetcher } from "../src/mcp/product-client";
import { postProduct } from "../src/mcp/product-client";
import {
  decodeRequest,
  encodeResponse,
  PRODUCT_OPERATIONS,
} from "@machine-memory/contract";
import { toProductRow } from "../../api/src/product-logic";

type SeenCall = {
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
};

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
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
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
};

async function linkedClient(bindings: { api: ApiFetcher; apiToken: string }) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMemoryServer(bindings);
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
  test("memory_get carries all metadata from database row through the gateway", async () => {
    const memory = toProductRow({
      ...FULL_ROW,
      refs: JSON.stringify(FULL_ROW.refs),
    });
    const client = await linkedClient({
      api: stubApi(
        {
          "/product/get": {
            status: 200,
            body: encodeResponse(PRODUCT_OPERATIONS.get.response, {
              ok: true,
              result: memory,
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
    const get = tools.find((tool) => tool.name === "memory_get");
    expect(JSON.stringify(get?.inputSchema)).toContain("64 UTF-8 bytes");
    const add = tools.find((tool) => tool.name === "memory_add");
    expect(JSON.stringify(add?.inputSchema)).toContain("weak match refuses");
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

  test("memory_query unwraps results and forwards auth + path + body", async () => {
    const seen: SeenCall[] = [];
    const client = await linkedClient({
      api: stubApi(
        {
          "/product/query": {
            status: 200,
            body: {
              ok: true,
              result: { count: 1, results: [{ ...ROW, score: 12.5 }] },
            },
          },
        },
        seen,
      ),
      apiToken: "test-token",
    });
    const result = await client.callTool({
      name: "memory_query",
      arguments: { repository: "o/r", query: "deploy" },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual([{ ...ROW, score: 12.5 }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain("/product/query");
    expect(seen[0]?.authorization).toBe("Bearer test-token");
    expect(seen[0]?.body).toMatchObject({ repository: "o/r", query: "deploy" });
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
      source: "bytes",
      bytes_estimate: 600,
      max_bytes_estimate: 512,
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

  test("memory_update by match echoes the api matched resolution", async () => {
    const seen: SeenCall[] = [];
    const write = {
      written_to: "o/r",
      id: 7,
      memory: FULL_ROW,
      size: {
        source: "bytes",
        bytes_estimate: 100,
        max_bytes_estimate: 512,
        within_budget: true,
        binding_limit: null,
        over_by_bytes: 0,
        remaining: 412,
        limits: { bytes_estimate: { value: 100, limit: 512, pass: true } },
      },
      matched: { query: "deploy", id: 7, score: 42.5 },
    };
    const client = await linkedClient({
      api: stubApi(
        {
          "/product/update": { status: 200, body: { ok: true, result: write } },
        },
        seen,
      ),
      apiToken: "test-token",
    });
    const result = await client.callTool({
      name: "memory_update",
      arguments: {
        repository: "o/r",
        match: "deploy",
        content: "deploy updated",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual([write]);
  });

  test("list_repositories unwraps the repository array", async () => {
    const seen: SeenCall[] = [];
    const client = await linkedClient({
      api: stubApi(
        {
          "/product/list-repositories": {
            status: 200,
            body: { ok: true, result: { repositories: ["o/r"], count: 1 } },
          },
        },
        seen,
      ),
      apiToken: "test-token",
    });
    const result = await client.callTool({
      name: "list_repositories",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual(["o/r"]);
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

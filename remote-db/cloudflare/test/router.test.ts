import { expect, test } from "bun:test";
import router, { type Env, type ServiceFetcher } from "../src/router/index";

interface RecordedRequest {
  pathname: string;
  search: string;
  method: string;
}

type BindingName = "API" | "MCP" | "DOCS_WORKER";

function makeEnv(withDocs = true): {
  calls: Record<BindingName, RecordedRequest[]>;
  env: Env;
} {
  const calls: Record<BindingName, RecordedRequest[]> = {
    API: [],
    MCP: [],
    DOCS_WORKER: [],
  };

  const stub = (binding: BindingName): ServiceFetcher => ({
    fetch: async (input: Request | string, init?: RequestInit) => {
      const request =
        typeof input === "string" ? new Request(input, init) : input;
      const url = new URL(request.url);
      calls[binding].push({
        pathname: url.pathname,
        search: url.search,
        method: request.method,
      });
      return new Response(`${binding}-ok`, { status: 200 });
    },
  });

  return {
    calls,
    env: {
      API: stub("API"),
      MCP: stub("MCP"),
      ...(withDocs ? { DOCS_WORKER: stub("DOCS_WORKER") } : {}),
    },
  };
}

const request = (path: string, withDocs = true) => {
  const { calls, env } = makeEnv(withDocs);
  const response = router.request(path, {}, env);
  return { response, calls };
};

test("/mcp goes to MCP with path intact", async () => {
  const { response, calls } = request("https://mm.example/mcp");
  await response;
  expect(calls.MCP.map((c) => c.pathname)).toEqual(["/mcp"]);
  expect(calls.DOCS_WORKER).toEqual([]);
});

test("/mcp/* stays on MCP (not docs)", async () => {
  const { response, calls } = request("https://mm.example/mcp/session/x");
  await response;
  expect(calls.MCP.map((c) => c.pathname)).toEqual(["/mcp/session/x"]);
  expect(calls.DOCS_WORKER).toEqual([]);
});

test("OAuth paths go to MCP", async () => {
  const { response, calls } = request(
    "https://mm.example/authorize?client_id=1",
  );
  await response;
  expect(calls.MCP[0]?.pathname).toBe("/authorize");
  expect(calls.MCP[0]?.search).toBe("?client_id=1");
});

test("/.well-known oauth discovery goes to MCP", async () => {
  const { response, calls } = request(
    "https://mm.example/.well-known/oauth-authorization-server",
  );
  await response;
  expect(calls.MCP.map((c) => c.pathname)).toEqual([
    "/.well-known/oauth-authorization-server",
  ]);
});

test("/query goes to API", async () => {
  const { response, calls } = request("https://mm.example/query");
  await response;
  expect(calls.API.map((c) => c.pathname)).toEqual(["/query"]);
});

test("/migrate/links goes to API", async () => {
  const { response, calls } = request("https://mm.example/migrate/links");
  await response;
  expect(calls.API.map((c) => c.pathname)).toEqual(["/migrate/links"]);
});

test("/vectorize/search goes to API", async () => {
  const { response, calls } = request("https://mm.example/vectorize/search");
  await response;
  expect(calls.API.map((c) => c.pathname)).toEqual(["/vectorize/search"]);
});

test("docs paths and root go to docs", async () => {
  const { response, calls } = request("https://mm.example/docs/mcp/overview");
  await response;
  expect(calls.DOCS_WORKER.map((c) => c.pathname)).toEqual([
    "/docs/mcp/overview",
  ]);
  expect(calls.MCP).toEqual([]);
});

test("root goes to docs", async () => {
  const { response, calls } = request("https://mm.example/");
  await response;
  expect(calls.DOCS_WORKER.map((c) => c.pathname)).toEqual(["/"]);
});

test("without docs binding, catch-all is 404", async () => {
  const { response, calls } = request("https://mm.example/installation", false);
  const result = await response;
  expect(result.status).toBe(404);
  expect(calls.DOCS_WORKER).toEqual([]);
  expect(calls.API).toEqual([]);
  expect(calls.MCP).toEqual([]);
});

import { describe, expect, test, vi } from "vitest";
import { Effect, Redacted } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  PRODUCT_ROUTES,
  productRoutePath,
  type ProductRoute,
  type JsonValue,
} from "@machine-memory/contract";
import {
  classifyRestFailure,
  handleRestRequest,
  type RestHandlers,
} from "../../api/src/rest-handlers";

function responseJson(
  response: HttpServerResponse.HttpServerResponse,
): unknown {
  const body = response.body.toJSON() as { readonly body?: unknown };
  return JSON.parse(String(body.body));
}

function setup(failingProduct?: RestHandlers<never>["handleProduct"]) {
  const ok = () => Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true }));
  const product = vi.fn(
    failingProduct ?? ((_route: ProductRoute, _body: JsonValue) => ok()),
  );
  const vectorize = vi.fn(ok);
  const handlers: RestHandlers<never> = {
    expectedToken: Redacted.make("token"),
    handleQuery: ok,
    handleMigration: ok,
    handleMigrationLinks: ok,
    handleVectorizeUpsert: vectorize,
    handleVectorizeSearch: vectorize,
    handleVectorizeDelete: vectorize,
    handleProduct: product,
  };
  const call = (path: string, token = "token") =>
    Effect.runPromise(
      handleRestRequest(
        handlers,
        HttpServerRequest.fromWeb(
          new Request(`https://api.test${path}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ repository: "o/r" }),
          }),
        ),
      ),
    );
  return { call, product, vectorize };
}

describe("REST product route catalog", () => {
  test.each(PRODUCT_ROUTES)(
    "dispatches %s using the shared route name",
    async (route) => {
      const { call, product, vectorize } = setup();
      expect((await call(productRoutePath(route))).status).toBe(200);
      expect(product).toHaveBeenCalledExactlyOnceWith(route, {
        repository: "o/r",
      });
      expect(vectorize).not.toHaveBeenCalled();
    },
  );
  test.each([
    "/product/unknown",
    "/product/toString",
    "/product/list_repositories",
    "/product/get/extra",
  ])("rejects unknown or obsolete route %s", async (path) => {
    const { call, product, vectorize } = setup();
    expect((await call(path)).status).toBe(404);
    expect(product).not.toHaveBeenCalled();
    expect(vectorize).not.toHaveBeenCalled();
  });
  test("auth still guards product dispatch", async () => {
    const { call, product } = setup();
    expect((await call("/product/get", "wrong")).status).toBe(401);
    expect(product).not.toHaveBeenCalled();
  });

  test("returns actionable guidance for correctable FTS failures", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const { call } = setup(() =>
        Effect.fail(new Error("SQLITE_ERROR: fts5: syntax error near '*'")),
      );
      const response = await call("/product/query");
      expect(response.status).toBe(400);
      expect(responseJson(response)).toMatchObject({
        ok: false,
        error: expect.stringContaining("Use simpler words"),
      });
      expect(error).toHaveBeenCalledWith(
        "REST /product/query failed [fts-query].",
      );
    } finally {
      error.mockRestore();
    }
  });

  test("guides pattern failures without blaming input or leaking diagnostics", async () => {
    expect(
      classifyRestFailure(
        new Error("SQLITE_ERROR: LIKE or GLOB pattern too complex"),
      ),
    ).toMatchObject({
      status: 500,
      category: "pattern-complexity",
      error: expect.stringContaining("If machine-memory generated the pattern"),
    });

    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const { call } = setup(() =>
        Effect.fail(new Error("unexpected secret=request-body-content")),
      );
      const response = await call("/product/suggest");
      expect(response.status).toBe(500);
      expect(responseJson(response)).toEqual({
        ok: false,
        error: "Internal server error.",
      });
      expect(error).not.toHaveBeenCalledWith(
        expect.stringContaining("request-body-content"),
      );
    } finally {
      error.mockRestore();
    }
  });
});

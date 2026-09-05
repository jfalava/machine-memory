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
  handleRestRequest,
  type RestHandlers,
} from "../../api/src/rest-handlers";

function setup() {
  const ok = () => Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true }));
  const product = vi.fn((_route: ProductRoute, _body: JsonValue) => ok());
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
});

import { expect, test } from "bun:test";

import * as Cloudflare from "alchemy/Cloudflare";
import { findProviderByType } from "alchemy/Provider";
import * as State from "alchemy/State";
import { run, withProviders } from "alchemy/Test/Core";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";

test("existing Worker precreate does not wait for newly declared DO classes", async () => {
  const requests: string[] = [];
  const client = HttpClient.make((request) => {
    requests.push(request.url);
    expect(request.method).toBe("GET");
    let result: unknown;
    if (request.url.endsWith("/settings")) {
      result = {
        bindings: [
          {
            type: "durable_object_namespace",
            name: "Existing",
            className: "Existing",
            namespaceId: "preserved-namespace-id",
          },
        ],
        tags: [],
        logpush: false,
      };
    } else if (request.url.endsWith("/scripts")) {
      result = [{ id: "existing-api", tag: "existing-worker-id" }];
    } else {
      return Effect.die(`Unexpected request: ${request.url}`);
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ success: true, result, errors: [], messages: [] }),
      ),
    );
  });
  const providers = Cloudflare.providers();
  const state = Layer.succeed(State.State, State.InMemoryService({}));
  const effect = withProviders(
    Effect.gen(function* () {
      const provider = yield* findProviderByType<Cloudflare.Worker>(
        Cloudflare.Worker.Type,
        "live",
      );
      if (!provider.precreate) throw new Error("Worker must support precreate");
      return yield* provider
        .precreate({
          id: "api",
          fqn: "api",
          instanceId: "test-instance",
          news: { name: "existing-api", workersDev: false },
          bindings: [
            {
              sid: "VectorCoordinator",
              data: {
                bindings: [
                  {
                    type: "durable_object_namespace",
                    name: "VectorCoordinator",
                    className: "VectorCoordinator",
                  },
                ],
              },
            },
          ],
          session: {
            note: () => Effect.void,
            emit: () => Effect.void,
            done: () => Effect.void,
          },
        })
        .pipe(Effect.timeout("1 second"));
    }),
    { providers, state, dev: false, sidecar: false },
    "worker-precreate-test",
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
        CLOUDFLARE_API_TOKEN: "offline-test-token",
      }),
    ),
  );
  const output = await run(effect, {
    providers,
    state,
    dev: false,
    sidecar: false,
  });
  expect(output.workerName).toBe("existing-api");
  expect(output.workerId).toBe("existing-worker-id");
  expect(output.durableObjectNamespaces).toEqual({
    Existing: "preserved-namespace-id",
  });
  expect(requests).toHaveLength(2);
});

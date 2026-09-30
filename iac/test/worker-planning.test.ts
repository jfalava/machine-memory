import { expect, test } from "bun:test";

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import { run } from "alchemy/Test/Core";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

import Api from "../../api/src/worker";

test("API Worker discovers bindings without accessing runtime namespaces", async () => {
  const providers = Cloudflare.providers();
  const state = Layer.succeed(State.State, State.InMemoryService({}));
  const stack = Alchemy.Stack(
    "worker-planning-test",
    { providers, state },
    Effect.gen(function* () {
      yield* Api;
    }),
  ).pipe(
    Effect.provideService(Stage, "test"),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        ALCHEMY_PHASE: "plan",
        CLOUDFLARE_ACCOUNT_ID: "offline-test-account",
        CLOUDFLARE_API_TOKEN: "offline-test-token",
        MACHINE_MEMORY_DB_TOKEN: "offline-test-db-token",
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Planning must not make HTTP requests")),
    ),
  );

  const compiled = await run(stack, {
    providers,
    state,
    dev: false,
    sidecar: false,
  });
  expect(compiled.resources).toHaveProperty("machine-memory-api");
  expect(compiled.bindings["machine-memory-api"]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          bindings: expect.arrayContaining([
            expect.objectContaining({
              type: "durable_object_namespace",
              name: "VectorCoordinator",
              className: "VectorCoordinator",
            }),
          ]),
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({ crons: ["*/5 * * * *"] }),
      }),
    ]),
  );
});

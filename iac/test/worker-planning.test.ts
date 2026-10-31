import { expect, test } from "bun:test";

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import { run } from "alchemy/Test/Core";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import Api from "../../api/src/worker";
import Mcp from "../../mcp/src/worker";
import { bindApplicationSecrets } from "../src/secrets";

const decodeWorkerBindingData = Schema.decodeUnknownSync(
  Schema.Struct({
    bindings: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    crons: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

test.each([false, true])(
  "Workers plan without application secret values (OAuth: %s)",
  async (enableOAuth) => {
    const providers = Cloudflare.providers();
    const state = Layer.succeed(State.State, State.InMemoryService({}));
    const stack = Alchemy.Stack(
      "worker-planning-test",
      { providers, state },
      Effect.gen(function* () {
        const api = yield* Api;
        const mcp = yield* Mcp;
        const secrets = { storeId: "test-store", dbToken: "rest-bearer" };
        yield* bindApplicationSecrets(
          api,
          mcp,
          enableOAuth
            ? {
                ...secrets,
                oauth: {
                  githubClientId: "github-client",
                  githubClientSecret: "github-secret",
                  githubAllowedUserId: "github-owner",
                  cookieEncryptionKey: "cookie-key",
                },
              }
            : secrets,
        );
      }),
    ).pipe(
      Effect.provideService(Stage, "test"),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ALCHEMY_PHASE: "plan",
          CLOUDFLARE_ACCOUNT_ID: "offline-test-account",
          CLOUDFLARE_API_TOKEN: "offline-test-token",
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("Planning must not make HTTP requests"),
        ),
      ),
    );

    const compiled = await run(stack, {
      providers,
      state,
      dev: false,
      sidecar: false,
    });
    expect(compiled.resources).toHaveProperty("machine-memory-api");
    expect(compiled.resources).toHaveProperty("machine-memory-mcp");
    const token = {
      type: "secrets_store_secret",
      name: "MACHINE_MEMORY_DB_TOKEN",
      storeId: "test-store",
      secretName: "rest-bearer",
    };
    for (const [id, expected] of [
      ["machine-memory-api", [token]],
      [
        "machine-memory-mcp",
        [
          token,
          ...(enableOAuth
            ? [
                {
                  type: "secrets_store_secret",
                  name: "MACHINE_MEMORY_GITHUB_CLIENT_ID",
                  storeId: "test-store",
                  secretName: "github-client",
                },
                {
                  type: "secrets_store_secret",
                  name: "MACHINE_MEMORY_GITHUB_CLIENT_SECRET",
                  storeId: "test-store",
                  secretName: "github-secret",
                },
                {
                  type: "secrets_store_secret",
                  name: "MACHINE_MEMORY_GITHUB_ALLOWED_USER_ID",
                  storeId: "test-store",
                  secretName: "github-owner",
                },
                {
                  type: "secrets_store_secret",
                  name: "MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY",
                  storeId: "test-store",
                  secretName: "cookie-key",
                },
              ]
            : []),
        ],
      ],
    ] as const) {
      expect(compiled.bindings[id]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ data: { bindings: expected } }),
        ]),
      );
    }
    expect(JSON.stringify(compiled.bindings)).not.toContain("secret_text");
    const apiData = (compiled.bindings["machine-memory-api"] ?? []).map(
      (binding) => decodeWorkerBindingData(binding.data),
    );
    expect(apiData.flatMap((data) => data.bindings ?? [])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "durable_object_namespace",
          name: "VectorCoordinator",
          className: "VectorCoordinator",
        }),
      ]),
    );
    expect(apiData.map((data) => data.crons)).toContainEqual(["*/5 * * * *"]);
  },
);

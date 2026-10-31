import { expect, test } from "bun:test";

import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { readStoredSecret, SecretUnavailableError } from "../src/secrets";

test("stored secret values are read only when the request effect runs", async () => {
  let reads = 0;
  const effect = readStoredSecret("MACHINE_MEMORY_DB_TOKEN");
  expect(reads).toBe(0);

  const token = await Effect.runPromise(
    effect.pipe(
      Effect.provideService(Cloudflare.WorkerEnvironment, {
        MACHINE_MEMORY_DB_TOKEN: {
          get: async () => {
            reads += 1;
            return "runtime-token";
          },
        },
      }),
      Effect.provide(RuntimeContext.phantom),
    ),
  );

  expect(reads).toBe(1);
  expect(Redacted.value(token)).toBe("runtime-token");
});

test("a missing stored secret fails closed", async () => {
  const error = await Effect.runPromise(
    readStoredSecret("MACHINE_MEMORY_DB_TOKEN").pipe(
      Effect.provideService(Cloudflare.WorkerEnvironment, {}),
      Effect.provide(RuntimeContext.phantom),
      Effect.flip,
    ),
  );
  expect(error).toBeInstanceOf(SecretUnavailableError);
  expect(error.message).toContain(
    "Secrets Store binding MACHINE_MEMORY_DB_TOKEN is unavailable.",
  );
});

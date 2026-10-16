import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import type { SecretsStoreConfig } from "./deploy-config";

/** Attach references only; the stack never reads or manages secret values. */
export function bindApplicationSecrets(
  api: Cloudflare.Worker,
  mcp: Cloudflare.Worker,
  config: SecretsStoreConfig | undefined,
) {
  return Effect.gen(function* () {
    if (config === undefined) {
      return yield* Effect.die(
        new Error(
          "Deployment requires secretsStore.storeId and secretsStore.dbToken in machine-memory.deploy.json. Configure existing Secrets Store secret names, not secret values.",
        ),
      );
    }
    const binding = (name: string, secretName: string) => ({
      type: "secrets_store_secret" as const,
      name,
      storeId: config.storeId,
      secretName,
    });
    const token = binding("MACHINE_MEMORY_DB_TOKEN", config.dbToken);
    const oauth = config.oauth;
    yield* api.bind`application-secrets`({ bindings: [token] });
    yield* mcp.bind`application-secrets`({
      bindings: [
        token,
        ...(oauth === undefined
          ? []
          : [
              binding("MACHINE_MEMORY_GITHUB_CLIENT_ID", oauth.githubClientId),
              binding(
                "MACHINE_MEMORY_GITHUB_CLIENT_SECRET",
                oauth.githubClientSecret,
              ),
              binding(
                "MACHINE_MEMORY_GITHUB_ALLOWED_USER_ID",
                oauth.githubAllowedUserId,
              ),
              binding(
                "MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY",
                oauth.cookieEncryptionKey,
              ),
            ]),
      ],
    });
  });
}

/** Run only inside a request, never in the Worker's planning/init effect. */
export function readStoredSecret(
  name: string,
): Effect.Effect<
  Redacted.Redacted<string>,
  Error,
  Cloudflare.WorkerEnvironment | RuntimeContext
> {
  return Effect.gen(function* () {
    const env = yield* Cloudflare.WorkerEnvironment;
    // SAFETY: bindApplicationSecrets registers native Secrets Store bindings.
    const secret = env[name] as SecretsStoreSecret;
    return yield* Effect.tryPromise({
      try: () => secret.get(),
      catch: () => new Error(`Secrets Store binding ${name} is unavailable.`),
    }).pipe(Effect.map(Redacted.make));
  });
}

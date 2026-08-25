type RuntimeGlobals = typeof globalThis & {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

// SAFETY: RuntimeGlobals only adds optional members, so the assertion cannot misstate existing globals.
const environment = (globalThis as RuntimeGlobals).process?.env ?? {};

export const stackName =
  environment.MACHINE_MEMORY_STACK_NAME ?? "machine-memory-remote-db";
export const databaseName =
  environment.MACHINE_MEMORY_DB_NAME ?? "machine-memory-db";
export const apiName =
  environment.MACHINE_MEMORY_API_NAME ?? "machine-memory-api";
export const vectorIndexName =
  environment.MACHINE_MEMORY_VECTOR_INDEX_NAME ?? "machine-memory-v1";
export const oauthKvName =
  environment.MACHINE_MEMORY_OAUTH_KV_NAME ?? "machine-memory-oauth-kv";

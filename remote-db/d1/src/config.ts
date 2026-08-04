type RuntimeGlobals = typeof globalThis & {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

const environment = (globalThis as RuntimeGlobals).process?.env ?? {};

export const stackName = environment.MACHINE_MEMORY_STACK_NAME ?? "machine-memory-remote-db";
export const databaseName = environment.MACHINE_MEMORY_DB_NAME ?? "machine-memory-db";
export const apiName = environment.MACHINE_MEMORY_API_NAME ?? "machine-memory-api";

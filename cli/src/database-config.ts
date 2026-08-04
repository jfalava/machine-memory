export type DatabaseConfig =
  | {
      readonly kind: "local";
    }
  | {
      readonly kind: "remote";
      readonly url: string;
      readonly token: string | undefined;
    };

/**
 * Resolve the database backend for the current process.
 *
 * A D1 binding is only available inside a Worker, so the CLI talks to the
 * small authenticated Worker adapter exposed by MACHINE_MEMORY_DB_URL.
 */
export function databaseConfig(
  environment: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  const url = environment["MACHINE_MEMORY_DB_URL"]?.trim();
  if (url) {
    return {
      kind: "remote",
      url,
      token: environment["MACHINE_MEMORY_DB_TOKEN"],
    };
  }
  return { kind: "local" };
}

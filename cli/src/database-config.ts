import { jsonObject, jsonString, parseJson, type JsonObject } from "./json";

export type DatabaseConfig =
  | {
      readonly kind: "local";
    }
  | {
      readonly kind: "remote";
      readonly url: string;
      readonly token: string | undefined;
      readonly stackName?: string;
      readonly databaseName?: string;
      readonly apiName?: string;
    };

export type DatabaseBackendFlags = {
  readonly local: boolean;
  readonly remote: boolean;
};

export const DEFAULT_DATABASE_BACKEND_FLAGS: DatabaseBackendFlags = {
  local: false,
  remote: false,
};

export function validateDatabaseBackendFlags(
  backendFlags: DatabaseBackendFlags,
  requireSelection = false,
): void {
  if (backendFlags.local && backendFlags.remote) {
    throw new Error("Choose only one database backend: --local or --remote.");
  }
  if (requireSelection && !backendFlags.local && !backendFlags.remote) {
    throw new Error(
      "Choose a database backend explicitly with --local or --remote.",
    );
  }
}

export type RemoteCredentials = {
  readonly url: string;
  readonly token: string;
  readonly stackName?: string;
  readonly databaseName?: string;
  readonly apiName?: string;
};

export const REMOTE_CREDENTIALS_SECRET = {
  service: "com.machine-memory.cli",
  name: "cloudflare-d1",
} as const;

/**
 * Resolve the database backend for the current process.
 *
 * A D1 binding is only available inside a Worker, so the CLI talks to the
 * small authenticated Worker adapter exposed by MACHINE_MEMORY_DB_URL.
 */
export function databaseConfig(
  environment: Record<string, string | undefined> = process.env,
  backendFlags: DatabaseBackendFlags = DEFAULT_DATABASE_BACKEND_FLAGS,
): DatabaseConfig {
  validateDatabaseBackendFlags(backendFlags);
  if (backendFlags.local) {
    return { kind: "local" };
  }
  const url = environment["MACHINE_MEMORY_DB_URL"]?.trim();
  if (url) {
    return {
      kind: "remote",
      url: normalizeRemoteUrl(url),
      token: environment["MACHINE_MEMORY_DB_TOKEN"],
    };
  }
  if (environment["MACHINE_MEMORY_DB_PATH"]?.trim()) {
    return { kind: "local" };
  }
  return { kind: "local" };
}

async function storedRemoteConfig(
  required: boolean,
): Promise<DatabaseConfig | undefined> {
  let stored: string | null;
  try {
    stored = await Bun.secrets.get(REMOTE_CREDENTIALS_SECRET);
  } catch (cause) {
    if (required) {
      throw new Error(
        `Remote backend requested, but stored credentials could not be read from the OS keychain. Set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKEN. ${String(cause)}`,
      );
    }
    return undefined;
  }
  if (!stored) {
    if (required) {
      throw new Error(
        "Remote backend requested, but no remote credentials are configured. Set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKEN or run 'machine-memory remote setup' if not already done.",
      );
    }
    return undefined;
  }
  return {
    kind: "remote",
    ...parseRemoteCredentials(stored),
  };
}

export async function loadDatabaseConfig(
  environment: Record<string, string | undefined> = process.env,
  backendFlags: DatabaseBackendFlags = DEFAULT_DATABASE_BACKEND_FLAGS,
): Promise<DatabaseConfig> {
  const configured = databaseConfig(environment, backendFlags);
  if (backendFlags.local) {
    // An explicit --local selection must never be overridden by stored
    // remote credentials or by MACHINE_MEMORY_DB_PATH fallbacks.
    return configured;
  }
  if (backendFlags.remote && configured.kind === "local") {
    return (await storedRemoteConfig(true)) ?? configured;
  }
  if (configured.kind === "remote") {
    return configured;
  }
  if (environment["MACHINE_MEMORY_DB_PATH"]?.trim()) {
    return configured;
  }
  return (await storedRemoteConfig(false)) ?? configured;
}

export async function loadStoredRemoteCredentials(): Promise<
  RemoteCredentials | undefined
> {
  const stored = await Bun.secrets.get(REMOTE_CREDENTIALS_SECRET);
  return stored ? parseRemoteCredentials(stored) : undefined;
}

function parseOptionalRemoteCredentials(
  candidate: JsonObject,
): Pick<RemoteCredentials, "stackName" | "databaseName" | "apiName"> {
  const optional: Pick<
    RemoteCredentials,
    "stackName" | "databaseName" | "apiName"
  > = {};
  const fields = [
    ["stackName", jsonString(candidate.stackName)],
    ["databaseName", jsonString(candidate.databaseName)],
    ["apiName", jsonString(candidate.apiName)],
  ] as const;
  for (const [field, value] of fields) {
    if (value !== undefined) {
      Object.assign(optional, { [field]: value });
    }
  }
  return optional;
}

function parseRemoteCredentials(stored: string): RemoteCredentials {
  let parsed: ReturnType<typeof parseJson>;
  try {
    parsed = parseJson(stored);
  } catch (cause) {
    throw new Error(
      `Stored remote credentials are invalid. Set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKEN or run 'machine-memory remote setup' again to overwrite them. ${String(cause)}`,
    );
  }
  const candidate = jsonObject(parsed);
  if (candidate === undefined) {
    throw new Error(
      "Stored remote credentials are invalid. Set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKEN or run 'machine-memory remote setup' again to overwrite them.",
    );
  }
  const url = jsonString(candidate.url);
  const token = jsonString(candidate.token);
  if (
    url === undefined ||
    token === undefined ||
    url.length === 0 ||
    token.length === 0
  ) {
    throw new Error(
      "Stored remote credentials are invalid. Set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKEN or run 'machine-memory remote setup' again to overwrite them.",
    );
  }
  return {
    url,
    token,
    ...parseOptionalRemoteCredentials(candidate),
  };
}

export function normalizeRemoteUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Worker URL must use http:// or https://.");
  }
  parsed.search = "";
  parsed.hash = "";
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith("/query")
    ? path || "/query"
    : `${path}/query`;
  return parsed.toString();
}

export async function saveRemoteCredentials(
  credentials: RemoteCredentials,
): Promise<void> {
  await Bun.secrets.set({
    ...REMOTE_CREDENTIALS_SECRET,
    value: JSON.stringify(credentials),
  });
}

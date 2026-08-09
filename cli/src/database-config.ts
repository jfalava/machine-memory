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

export async function loadDatabaseConfig(
  environment: Record<string, string | undefined> = process.env,
  backendFlags: DatabaseBackendFlags = DEFAULT_DATABASE_BACKEND_FLAGS,
): Promise<DatabaseConfig> {
  const configured = databaseConfig(environment, backendFlags);
  if (backendFlags.remote && configured.kind === "local") {
    let stored: string | null;
    try {
      stored = await Bun.secrets.get(REMOTE_CREDENTIALS_SECRET);
    } catch (cause) {
      throw new Error(
        `Remote backend requested, but stored credentials could not be read. Run 'machine-memory remote setup'. ${String(cause)}`,
      );
    }
    if (!stored) {
      throw new Error(
        "Remote backend requested, but no remote credentials are configured. Run 'machine-memory remote setup'.",
      );
    }
    return {
      kind: "remote",
      ...parseRemoteCredentials(stored),
    };
  }
  if (configured.kind === "remote") {
    return configured;
  }
  if (environment["MACHINE_MEMORY_DB_PATH"]?.trim()) {
    return configured;
  }

  let stored: string | null;
  try {
    stored = await Bun.secrets.get(REMOTE_CREDENTIALS_SECRET);
  } catch {
    // Keep the local backend usable on hosts without a configured secret
    // service. The setup command still reports storage errors to the user.
    return configured;
  }
  if (!stored) {
    return configured;
  }

  return {
    kind: "remote",
    ...parseRemoteCredentials(stored),
  };
}

export async function loadStoredRemoteCredentials(): Promise<
  RemoteCredentials | undefined
> {
  const stored = await Bun.secrets.get(REMOTE_CREDENTIALS_SECRET);
  return stored ? parseRemoteCredentials(stored) : undefined;
}

function parseRemoteCredentials(stored: string): RemoteCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch (cause) {
    throw new Error(
      `Stored remote credentials are invalid. Run 'machine-memory remote setup' again. ${String(cause)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      "Stored remote credentials are invalid. Run 'machine-memory remote setup' again.",
    );
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.url !== "string" ||
    typeof candidate.token !== "string" ||
    candidate.url.length === 0 ||
    candidate.token.length === 0
  ) {
    throw new Error(
      "Stored remote credentials are invalid. Run 'machine-memory remote setup' again.",
    );
  }
  return {
    url: candidate.url,
    token: candidate.token,
    ...(typeof candidate.stackName === "string"
      ? { stackName: candidate.stackName }
      : {}),
    ...(typeof candidate.databaseName === "string"
      ? { databaseName: candidate.databaseName }
      : {}),
    ...(typeof candidate.apiName === "string"
      ? { apiName: candidate.apiName }
      : {}),
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

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Schema } from "effect";
import {
  jsonObject,
  jsonString,
  type JsonObject,
  type JsonValue,
} from "./json";

type RuntimeGlobals = typeof globalThis & {
  process?: {
    env?: Record<string, string | undefined>;
    cwd?: () => string;
  };
};

// SAFETY: RuntimeGlobals only adds optional members; assertion cannot misstate existing globals.
const hostProcess = (globalThis as RuntimeGlobals).process;

function envMap(): Record<string, string | undefined> {
  return hostProcess?.env ?? {};
}

function cwd(): string {
  return hostProcess?.cwd?.() ?? ".";
}

export type DeployWorkers = {
  readonly router: string;
  readonly api: string;
  readonly mcp: string;
  readonly docs: string;
};

export type DeployConfig = {
  readonly stackName: string;
  readonly databaseName: string;
  readonly vectorIndexName: string;
  readonly oauthKvName: string;
  readonly workers: DeployWorkers;
  readonly domain: string | undefined;
  readonly docs: boolean;
  readonly configPath: string | undefined;
};

export type DeployConfigEnv = {
  readonly MACHINE_MEMORY_STACK_NAME: string;
  readonly MACHINE_MEMORY_DB_NAME: string;
  readonly MACHINE_MEMORY_VECTOR_INDEX_NAME: string;
  readonly MACHINE_MEMORY_OAUTH_KV_NAME: string;
  readonly MACHINE_MEMORY_ROUTER_NAME: string;
  readonly MACHINE_MEMORY_API_NAME: string;
  readonly MACHINE_MEMORY_MCP_NAME: string;
  readonly MACHINE_MEMORY_DOCS_NAME: string;
  readonly MACHINE_MEMORY_DEPLOY_DOCS: string;
  readonly MACHINE_MEMORY_DOMAIN: string;
};

export const DEFAULT_DEPLOY_CONFIG: Omit<DeployConfig, "configPath"> = {
  stackName: "machine-memory-remote-db",
  databaseName: "machine-memory-db",
  vectorIndexName: "machine-memory-v1",
  oauthKvName: "machine-memory-oauth-kv",
  workers: {
    router: "machine-memory-router",
    api: "machine-memory-api",
    mcp: "machine-memory-mcp",
    docs: "machine-memory-docs",
  },
  domain: undefined,
  docs: true,
};

type DeployOverrides = Partial<{
  domain: string | undefined;
  docs: boolean;
  stackName: string;
  databaseName: string;
  vectorIndexName: string;
  oauthKvName: string;
  workers: Partial<DeployWorkers>;
}>;

function optionalNonEmpty(
  candidate: JsonObject,
  field: string,
): string | undefined {
  if (!(field in candidate)) {
    return undefined;
  }
  const parsed = jsonString(candidate[field]);
  if (parsed === undefined) {
    throw new Error(`${field} must be a string.`);
  }
  const trimmed = parsed.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function optionalBoolean(
  candidate: JsonObject,
  field: string,
): boolean | undefined {
  if (!(field in candidate)) {
    return undefined;
  }
  try {
    return Schema.decodeUnknownSync(Schema.Boolean)(candidate[field]);
  } catch {
    throw new Error(`${field} must be a boolean.`);
  }
}

function parseDeployFile(raw: string, path: string): Partial<DeployConfig> {
  let root: JsonValue;
  try {
    root = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(raw));
  } catch (cause) {
    throw new Error(
      `Could not parse deploy config at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const file = jsonObject(root);
  if (file === undefined) {
    throw new Error(`Deploy config at ${path} must be a JSON object.`);
  }
  const workersObject = jsonObject(file.workers) ?? {};
  return {
    domain: optionalNonEmpty(file, "domain"),
    docs: optionalBoolean(file, "docs"),
    stackName: optionalNonEmpty(file, "stackName"),
    databaseName: optionalNonEmpty(file, "database"),
    vectorIndexName: optionalNonEmpty(file, "vectorIndex"),
    oauthKvName: optionalNonEmpty(file, "oauthKv"),
    workers: {
      router:
        optionalNonEmpty(workersObject, "router") ??
        DEFAULT_DEPLOY_CONFIG.workers.router,
      api:
        optionalNonEmpty(workersObject, "api") ??
        DEFAULT_DEPLOY_CONFIG.workers.api,
      mcp:
        optionalNonEmpty(workersObject, "mcp") ??
        DEFAULT_DEPLOY_CONFIG.workers.mcp,
      docs:
        optionalNonEmpty(workersObject, "docs") ??
        DEFAULT_DEPLOY_CONFIG.workers.docs,
    },
  };
}

function envTruthy(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(
    `MACHINE_MEMORY_DEPLOY_DOCS must be a boolean-like value, got '${value}'.`,
  );
}

function resolveConfigPath(path: string): string {
  return isAbsolute(path) ? path : resolve(cwd(), path);
}

function discoverConfigPath(explicit: string | undefined): string | undefined {
  if (explicit) {
    return resolveConfigPath(explicit);
  }
  const envPath = envMap()["MACHINE_MEMORY_DEPLOY_CONFIG"]?.trim();
  if (envPath) {
    return resolveConfigPath(envPath);
  }
  const cwdFile = join(cwd(), "machine-memory.deploy.json");
  if (existsSync(cwdFile)) {
    return cwdFile;
  }
  if (existsSync(join(cwd(), "alchemy.run.ts"))) {
    const sibling = join(cwd(), "machine-memory.deploy.json");
    if (existsSync(sibling)) {
      return sibling;
    }
  }
  return undefined;
}

function pickString(
  override: string | undefined,
  envKey: string,
  fromFile: string | undefined,
  fallback: string,
): string {
  return override ?? envMap()[envKey]?.trim() ?? fromFile ?? fallback;
}

function resolveDomain(
  overrides: DeployOverrides | undefined,
  fromFile: Partial<DeployConfig> | undefined,
): string | undefined {
  if (overrides?.domain !== undefined) {
    return overrides.domain.trim() || undefined;
  }
  return (
    envMap()["MACHINE_MEMORY_DOMAIN"]?.trim() ||
    fromFile?.domain ||
    DEFAULT_DEPLOY_CONFIG.domain
  );
}

function resolveDocs(
  overrides: DeployOverrides | undefined,
  fromFile: Partial<DeployConfig> | undefined,
): boolean {
  return (
    overrides?.docs ??
    envTruthy(envMap()["MACHINE_MEMORY_DEPLOY_DOCS"]) ??
    fromFile?.docs ??
    DEFAULT_DEPLOY_CONFIG.docs
  );
}

function resolveWorkers(
  overrides: DeployOverrides | undefined,
  fromFile: Partial<DeployConfig> | undefined,
): DeployWorkers {
  const fileWorkers = fromFile?.workers;
  const overrideWorkers = overrides?.workers;
  return {
    router: pickString(
      overrideWorkers?.router,
      "MACHINE_MEMORY_ROUTER_NAME",
      fileWorkers?.router,
      DEFAULT_DEPLOY_CONFIG.workers.router,
    ),
    api: pickString(
      overrideWorkers?.api,
      "MACHINE_MEMORY_API_NAME",
      fileWorkers?.api,
      DEFAULT_DEPLOY_CONFIG.workers.api,
    ),
    mcp: pickString(
      overrideWorkers?.mcp,
      "MACHINE_MEMORY_MCP_NAME",
      fileWorkers?.mcp,
      DEFAULT_DEPLOY_CONFIG.workers.mcp,
    ),
    docs: pickString(
      overrideWorkers?.docs,
      "MACHINE_MEMORY_DOCS_NAME",
      fileWorkers?.docs,
      DEFAULT_DEPLOY_CONFIG.workers.docs,
    ),
  };
}

/**
 * Resolve deploy naming, domain, and docs toggle.
 * Precedence: overrides → config file → env → defaults.
 */
// Config merge is intentionally branchy (override/env/file/default per field).
// oxlint-disable-next-line complexity -- field-wise precedence matrix
export function loadDeployConfig(options?: {
  readonly configPath?: string;
  readonly overrides?: DeployOverrides;
}): DeployConfig {
  const configPath = discoverConfigPath(options?.configPath);
  const fromFile =
    configPath === undefined || !existsSync(configPath)
      ? undefined
      : parseDeployFile(readFileSync(configPath, "utf8"), configPath);
  const overrides = options?.overrides;

  return {
    stackName: pickString(
      overrides?.stackName,
      "MACHINE_MEMORY_STACK_NAME",
      fromFile?.stackName,
      DEFAULT_DEPLOY_CONFIG.stackName,
    ),
    databaseName: pickString(
      overrides?.databaseName,
      "MACHINE_MEMORY_DB_NAME",
      fromFile?.databaseName,
      DEFAULT_DEPLOY_CONFIG.databaseName,
    ),
    vectorIndexName: pickString(
      overrides?.vectorIndexName,
      "MACHINE_MEMORY_VECTOR_INDEX_NAME",
      fromFile?.vectorIndexName,
      DEFAULT_DEPLOY_CONFIG.vectorIndexName,
    ),
    oauthKvName: pickString(
      overrides?.oauthKvName,
      "MACHINE_MEMORY_OAUTH_KV_NAME",
      fromFile?.oauthKvName,
      DEFAULT_DEPLOY_CONFIG.oauthKvName,
    ),
    workers: resolveWorkers(overrides, fromFile),
    domain: resolveDomain(overrides, fromFile),
    docs: resolveDocs(overrides, fromFile),
    configPath,
  };
}

export function deployConfigToEnv(config: DeployConfig): DeployConfigEnv {
  return {
    MACHINE_MEMORY_STACK_NAME: config.stackName,
    MACHINE_MEMORY_DB_NAME: config.databaseName,
    MACHINE_MEMORY_VECTOR_INDEX_NAME: config.vectorIndexName,
    MACHINE_MEMORY_OAUTH_KV_NAME: config.oauthKvName,
    MACHINE_MEMORY_ROUTER_NAME: config.workers.router,
    MACHINE_MEMORY_API_NAME: config.workers.api,
    MACHINE_MEMORY_MCP_NAME: config.workers.mcp,
    MACHINE_MEMORY_DOCS_NAME: config.workers.docs,
    MACHINE_MEMORY_DEPLOY_DOCS: config.docs ? "1" : "0",
    MACHINE_MEMORY_DOMAIN: config.domain ?? "",
  };
}

import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_DEPLOY_CONFIG,
  deployConfigToEnv,
  loadDeployConfig,
} from "../src/deploy-config";

const ENV_KEYS = [
  "MACHINE_MEMORY_STACK_NAME",
  "MACHINE_MEMORY_DB_NAME",
  "MACHINE_MEMORY_VECTOR_INDEX_NAME",
  "MACHINE_MEMORY_OAUTH_KV_NAME",
  "MACHINE_MEMORY_ROUTER_NAME",
  "MACHINE_MEMORY_API_NAME",
  "MACHINE_MEMORY_MCP_NAME",
  "MACHINE_MEMORY_DOCS_NAME",
  "MACHINE_MEMORY_DOMAIN",
  "MACHINE_MEMORY_DEPLOY_DOCS",
  "MACHINE_MEMORY_DEPLOY_CONFIG",
] as const;

function withCleanEnv(run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, Bun.env[key]);
    delete Bun.env[key];
  }
  try {
    run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) {
        delete Bun.env[key];
      } else {
        Bun.env[key] = value;
      }
    }
  }
}

test("defaults without file values or env", () => {
  withCleanEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "mm-deploy-"));
    const path = join(dir, "machine-memory.deploy.json");
    writeFileSync(path, JSON.stringify({ workers: { api: "a1" } }));
    const config = loadDeployConfig({ configPath: path });
    expect(config.workers.api).toBe("a1");
    expect(config.workers.router).toBe(DEFAULT_DEPLOY_CONFIG.workers.router);
    expect(config.docs).toBe(true);
    expect(config.domain).toBeUndefined();
    expect(config.stackName).toBe(DEFAULT_DEPLOY_CONFIG.stackName);
  });
});

test("file supplies domain, docs false, and worker names", () => {
  withCleanEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "mm-deploy-"));
    const path = join(dir, "machine-memory.deploy.json");
    writeFileSync(
      path,
      JSON.stringify({
        domain: "memory.example.com",
        docs: false,
        stackName: "my-stack",
        database: "my-db",
        workers: { router: "r1", api: "a1", mcp: "m1", docs: "d1" },
        secretsStore: {
          storeId: "store-1",
          dbToken: "db-token",
        },
      }),
    );
    const config = loadDeployConfig({ configPath: path });
    expect(config.domain).toBe("memory.example.com");
    expect(config.docs).toBe(false);
    expect(config.stackName).toBe("my-stack");
    expect(config.databaseName).toBe("my-db");
    expect(config.workers).toEqual({
      router: "r1",
      api: "a1",
      mcp: "m1",
      docs: "d1",
    });
    expect(config.configPath).toBe(path);
    expect(config.secretsStore).toEqual({
      storeId: "store-1",
      dbToken: "db-token",
    });
  });
});

test("env beats file", () => {
  withCleanEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "mm-deploy-"));
    const path = join(dir, "machine-memory.deploy.json");
    writeFileSync(
      path,
      JSON.stringify({ stackName: "from-file", docs: false }),
    );
    Bun.env.MACHINE_MEMORY_STACK_NAME = "from-env";
    Bun.env.MACHINE_MEMORY_DEPLOY_DOCS = "1";
    const config = loadDeployConfig({ configPath: path });
    expect(config.stackName).toBe("from-env");
    expect(config.docs).toBe(true);
  });
});

test("overrides beat file and env", () => {
  withCleanEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "mm-deploy-"));
    const path = join(dir, "machine-memory.deploy.json");
    writeFileSync(
      path,
      JSON.stringify({ domain: "from-file.example", docs: true }),
    );
    Bun.env.MACHINE_MEMORY_DOMAIN = "from-env.example";
    const config = loadDeployConfig({
      configPath: path,
      overrides: { domain: "from-flag.example", docs: false },
    });
    expect(config.domain).toBe("from-flag.example");
    expect(config.docs).toBe(false);
  });
});

test("deployConfigToEnv encodes docs and domain", () => {
  const env = deployConfigToEnv({
    ...DEFAULT_DEPLOY_CONFIG,
    domain: "x.example",
    docs: false,
    configPath: undefined,
  });
  expect(env.MACHINE_MEMORY_DEPLOY_DOCS).toBe("0");
  expect(env.MACHINE_MEMORY_DOMAIN).toBe("x.example");
  expect(env.MACHINE_MEMORY_ROUTER_NAME).toBe("machine-memory-router");
  expect(env.MACHINE_MEMORY_DEPLOY_CONFIG).toBe("");
});

test("preserves Secrets Store names as deployment references", () => {
  withCleanEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "mm-deploy-"));
    const path = join(dir, "secret-references.json");
    writeFileSync(
      path,
      JSON.stringify({
        secretsStore: { storeId: "store-1", dbToken: "db-token-name" },
      }),
    );
    expect(loadDeployConfig({ configPath: path }).secretsStore).toEqual({
      storeId: "store-1",
      dbToken: "db-token-name",
    });
  });
});

test("rejects non-object config file", () => {
  withCleanEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "mm-deploy-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, "[1,2,3]");
    expect(() => loadDeployConfig({ configPath: path })).toThrow(/JSON object/);
  });
});

test("rejects a missing explicit config path", () => {
  withCleanEnv(() => {
    const path = join(tmpdir(), "missing-mm-deploy.json");
    expect(() => loadDeployConfig({ configPath: path })).toThrow(
      /Deploy config not found/,
    );
  });
});

test("warns and uses defaults when the env config path is missing", () => {
  withCleanEnv(() => {
    const path = join(tmpdir(), "missing-mm-deploy-env.json");
    Bun.env.MACHINE_MEMORY_DEPLOY_CONFIG = path;
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const config = loadDeployConfig();
      expect(config.configPath).toBeUndefined();
      expect(config.stackName).toBe(DEFAULT_DEPLOY_CONFIG.stackName);
      expect(config.workers).toEqual(DEFAULT_DEPLOY_CONFIG.workers);
      expect(config.docs).toBe(true);
      expect(config.domain).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(path);
    } finally {
      warn.mockRestore();
    }
  });
});

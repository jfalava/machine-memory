import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as databaseConfig from "@/database-config";
import { remoteSetup } from "@/cli/commands/remote";
import type { CommandContext } from "@/cli/runtime/context";

const localEnv: Record<string, string | undefined> = {
  MACHINE_MEMORY_DB_URL: undefined,
  MACHINE_MEMORY_DB_TOKEN: undefined,
  MACHINE_MEMORY_DB_PATH: undefined,
};

describe("loadCurrentRemoteConfig", () => {
  it("does not consult the keychain when env already has a Worker URL", async () => {
    let loaded = 0;
    const result = await databaseConfig.loadCurrentRemoteConfig(
      {
        ...localEnv,
        MACHINE_MEMORY_DB_URL: "https://example.workers.dev",
        MACHINE_MEMORY_DB_TOKEN: "env-token",
      },
      async () => {
        loaded += 1;
        throw new Error("Secret service is locked");
      },
    );

    expect(loaded).toBe(0);
    expect(result.warningCause).toBeUndefined();
    expect(result.config).toMatchObject({
      kind: "remote",
      token: "env-token",
    });
  });

  it("returns local defaults instead of throwing when the keychain cannot be read", async () => {
    const cause = new Error("Secret service is locked");
    const result = await databaseConfig.loadCurrentRemoteConfig(localEnv, async () => {
      throw cause;
    });

    expect(result.config).toEqual({ kind: "local" });
    expect(result.warningCause).toBe(cause);
  });

  it("uses stored credentials when the keychain read succeeds", async () => {
    const result = await databaseConfig.loadCurrentRemoteConfig(localEnv, async () => ({
      url: "https://stored.example/query",
      token: "stored-token",
    }));

    expect(result.warningCause).toBeUndefined();
    expect(result.config).toEqual({
      kind: "remote",
      url: "https://stored.example/query",
      token: "stored-token",
    });
  });
});

describe("remote setup with a locked keychain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves --url and --token without failing the command", async () => {
    vi.spyOn(databaseConfig, "loadCurrentRemoteConfig").mockResolvedValue({
      config: { kind: "local" },
      warningCause: new Error("Secret service is locked"),
    });
    const save = vi
      .spyOn(databaseConfig, "saveRemoteCredentials")
      .mockResolvedValue(undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await Effect.runPromise(
      remoteSetup({
        args: [
          "--url",
          "https://example.workers.dev",
          "--token",
          "secret-token",
        ],
        command: "setup",
        outputMode: {
          brief: false,
          jsonMin: false,
          noConflicts: false,
          pretty: false,
          quiet: false,
        },
        database: undefined,
        fileSystem: {} as CommandContext["fileSystem"],
      }),
    );

    expect(save).toHaveBeenCalledWith({
      url: "https://example.workers.dev/query",
      token: "secret-token",
      stackName: undefined,
      databaseName: undefined,
      apiName: undefined,
    });
    expect(info.mock.calls.flat().join("\n")).toContain("--url");
    expect(error.mock.calls.flat().join("\n")).not.toContain(
      "✗ remote setup failed",
    );
  });
});

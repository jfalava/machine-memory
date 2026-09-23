import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, test, vi } from "vitest";

import { githubHandler } from "../src/auth/github-handler";
import type { OAuthEnv } from "../src/auth/oauth-provider";
import {
  bindStateToSession,
  createOAuthState,
  isAllowedGithubUserId,
} from "../src/auth/oauth-utils";
import type { ApiFetcher } from "../src/mcp/product-client";

type StoredValues = Map<string, string>;

function testKv(values: StoredValues): KVNamespace {
  return {
    delete: async (key: string) => {
      values.delete(key);
      return true;
    },
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
}

function testEnv(
  kv: KVNamespace,
  completeAuthorization: OAuthHelpers["completeAuthorization"],
  allowedUserId = "42",
): OAuthEnv {
  return {
    api: { fetch: vi.fn() } as unknown as ApiFetcher,
    apiToken: "api-token",
    // Ordinary browser OAuth must never touch the device database.
    OAUTH_DEVICES: {
      prepare: () => {
        throw new Error("Unexpected device database access");
      },
    } as unknown as D1Database,
    MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY: "cookie-secret",
    MACHINE_MEMORY_GITHUB_ALLOWED_USER_ID: allowedUserId,
    MACHINE_MEMORY_GITHUB_CLIENT_ID: "client-id",
    MACHINE_MEMORY_GITHUB_CLIENT_SECRET: "client-secret",
    OAUTH_KV: kv,
    OAUTH_PROVIDER: {
      completeAuthorization,
    } as unknown as OAuthHelpers,
  };
}

const AUTH_REQUEST: AuthRequest = {
  clientId: "mcp-client",
  codeChallenge: undefined,
  codeChallengeMethod: undefined,
  issuer: undefined,
  redirectUri: "https://client.test/callback",
  resource: undefined,
  responseType: "code",
  scope: ["mcp:read", "mcp:write"],
  state: "client-state",
};

async function callbackResponse(
  githubUserId: number,
  allowedUserId = "42",
): Promise<{
  response: Response;
  completeAuthorization: ReturnType<typeof vi.fn>;
}> {
  const values = new Map<string, string>();
  const kv = testKv(values);
  const { stateToken } = await createOAuthState(AUTH_REQUEST, kv);
  const { setCookie } = await bindStateToSession(stateToken);
  const completeAuthorization = vi.fn(async () => ({
    redirectTo: "https://client.test/callback?code=machine-memory-token",
  }));
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response("access_token=github-access-token", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        email: "allowed@example.com",
        id: githubUserId,
        login: "different-from-numeric-id",
        name: "Allowed User",
      }),
    );
  vi.stubGlobal("fetch", fetchMock);

  const fetchHandler = githubHandler.fetch;
  if (fetchHandler === undefined) {
    throw new Error("GitHub handler does not expose fetch");
  }
  // SAFETY: the callback handler does not inspect the execution context.
  const executionContext = {} as ExecutionContext;
  const request = new Request(
    `https://mcp.test/callback?code=oauth-code&state=${stateToken}`,
    {
      headers: { Cookie: setCookie },
    },
  ) as Parameters<typeof fetchHandler>[0];
  const response = await fetchHandler(
    request,
    testEnv(kv, completeAuthorization, allowedUserId),
    executionContext,
  );
  return { completeAuthorization, response };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MCP GitHub user allowlist", () => {
  test.each([
    [42, "42", true],
    [42, "43", false],
    [42, "different-from-numeric-id", false],
    [undefined, "42", false],
  ] as const)(
    "compares numeric GitHub IDs exactly",
    (userId, allowed, expected) => {
      expect(isAllowedGithubUserId(userId, allowed)).toBe(expected);
    },
  );

  test("completes OAuth only for the configured numeric GitHub ID", async () => {
    const allowed = await callbackResponse(42);
    expect(allowed.response.status).toBe(302);
    expect(allowed.completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        props: expect.objectContaining({ githubUserId: 42 }),
      }),
    );

    const denied = await callbackResponse(43);
    expect(denied.response.status).toBe(403);
    expect(await denied.response.text()).toContain("not authorized");
    expect(denied.completeAuthorization).not.toHaveBeenCalled();
  });
});

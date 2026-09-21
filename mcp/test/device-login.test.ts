import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  beginDeviceActivation,
  claimDeviceApproval,
  DEVICE_GRANT_TYPE,
  pollDeviceLogin,
  startDeviceLogin,
} from "../src/auth/device-login";
import { githubHandler } from "../src/auth/github-handler";
import {
  bindStateToSession,
  createOAuthState,
} from "../src/auth/oauth-utils";
import type { OAuthEnv } from "../src/auth/oauth-provider";
import type { ApiFetcher } from "../src/mcp/product-client";

type Stored = Map<string, string>;

function testKv(values: Stored): KVNamespace {
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

function clientRecord(): string {
  return JSON.stringify({
    clientId: "headless-client",
    redirectUris: ["http://127.0.0.1/callback"],
    tokenEndpointAuthMethod: "none",
  });
}

function startBody(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    client_id: "headless-client",
    code_challenge: "challenge-from-verifier",
    code_challenge_method: "S256",
    redirect_uri: "http://127.0.0.1:43123/callback",
    ...overrides,
  });
  return params.toString();
}

async function start(
  kv: KVNamespace,
  body = startBody(),
): Promise<Response> {
  return startDeviceLogin(
    new Request("https://mcp.test/device/start", {
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }),
    kv,
  );
}

describe("headless MCP activation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("rejects a non-loopback redirect before storing a code", async () => {
    const values = new Map<string, string>([
      ["client:headless-client", clientRecord()],
    ]);
    const response = await start(
      testKv(values),
      startBody({ redirect_uri: "https://evil.example/callback" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
    });
    expect([...values.keys()].filter((key) => key.startsWith("device:"))).toEqual(
      [],
    );
  });

  test("stores only hashes and polls pending until the user code is claimed", async () => {
    const values = new Map<string, string>([
      ["client:headless-client", clientRecord()],
    ]);
    const kv = testKv(values);
    const started = await start(kv);
    expect(started.status).toBe(200);
    const body = (await started.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
    };
    expect(body.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(body.verification_uri).toBe("https://mcp.test/activate");
    expect([...values.values()].join("\n")).not.toContain(body.device_code);
    expect([...values.values()].join("\n")).not.toContain(
      body.user_code.replace("-", ""),
    );

    const pending = await pollDeviceLogin(
      new Request("https://mcp.test/token", {
        body: new URLSearchParams({
          client_id: "headless-client",
          device_code: body.device_code,
          grant_type: DEVICE_GRANT_TYPE,
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      kv,
    );
    expect(pending?.status).toBe(400);
    expect(await pending?.json()).toMatchObject({
      error: "authorization_pending",
    });

    const claimed = await claimDeviceApproval(
      kv,
      `device:${body.user_code.replace("-", "")}`,
      "headless-client",
      "http://127.0.0.1:43123/callback",
      "challenge-from-verifier",
    );
    expect(claimed).toBe(true);

    const replay = await pollDeviceLogin(
      new Request("https://mcp.test/token", {
        body: new URLSearchParams({
          client_id: "headless-client",
          device_code: body.device_code,
          grant_type: DEVICE_GRANT_TYPE,
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      kv,
    );
    expect(await replay?.json()).toMatchObject({ error: "expired_token" });

    const wrongClient = await claimDeviceApproval(
      kv,
      `device:${body.user_code.replace("-", "")}`,
      "other-client",
      "http://127.0.0.1:43123/callback",
      "challenge-from-verifier",
    );
    expect(wrongClient).toBe(false);
  });

  test("the activate form binds the typed code to the pending client request", async () => {
    const values = new Map<string, string>([
      ["client:headless-client", clientRecord()],
    ]);
    const kv = testKv(values);
    const started = await start(kv);
    const body = (await started.json()) as { user_code: string };

    const activation = await beginDeviceActivation(
      new Request("https://mcp.test/activate", {
        body: new URLSearchParams({ user_code: body.user_code.toLowerCase() }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      kv,
    );

    expect(activation.kind).toBe("redirect");
    if (activation.kind !== "redirect") {
      return;
    }
    const location = new URL(activation.location);
    expect(location.pathname).toBe("/authorize");
    expect(location.searchParams.get("client_id")).toBe("headless-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:43123/callback",
    );
    expect(location.searchParams.get("code_challenge")).toBe(
      "challenge-from-verifier",
    );
    expect(location.searchParams.get("state")).toBe(
      `device:${body.user_code.replace("-", "")}`,
    );

    const missing = await beginDeviceActivation(
      new Request("https://mcp.test/activate", {
        body: new URLSearchParams({ user_code: "ZZZZ-ZZZZ" }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      kv,
    );
    expect(missing.kind).toBe("response");
  });

  test("a denied GitHub user never claims the device code or completes the grant", async () => {
    const values = new Map<string, string>([
      ["client:headless-client", clientRecord()],
    ]);
    const kv = testKv(values);
    const started = await start(kv);
    const body = (await started.json()) as { user_code: string };
    const userCode = body.user_code.replace("-", "");
    const oauthReqInfo = {
      clientId: "headless-client",
      codeChallenge: "challenge-from-verifier",
      codeChallengeMethod: "S256" as const,
      redirectUri: "http://127.0.0.1:43123/callback",
      responseType: "code",
      scope: ["mcp:read", "mcp:write"],
      state: `device:${userCode}`,
    };
    const { stateToken } = await createOAuthState(oauthReqInfo, kv);
    const { setCookie } = await bindStateToSession(stateToken);
    const completeAuthorization = vi.fn(async () => ({
      redirectTo: "http://127.0.0.1:43123/callback?code=should-not-issue",
    }));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("access_token=github-access-token", {
            headers: { "content-type": "application/x-www-form-urlencoded" },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            email: "denied@example.com",
            id: 43,
            login: "denied",
            name: "Denied",
          }),
        ),
    );
    const fetchHandler = githubHandler.fetch;
    if (fetchHandler === undefined) {
      throw new Error("GitHub handler does not expose fetch");
    }
    const env: OAuthEnv = {
      api: { fetch: vi.fn() } as unknown as ApiFetcher,
      apiToken: "api-token",
      MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY: "cookie-secret",
      MACHINE_MEMORY_GITHUB_ALLOWED_USER_ID: "42",
      MACHINE_MEMORY_GITHUB_CLIENT_ID: "client-id",
      MACHINE_MEMORY_GITHUB_CLIENT_SECRET: "client-secret",
      OAUTH_KV: kv,
      OAUTH_PROVIDER: {
        completeAuthorization,
      } as unknown as OAuthHelpers,
    };
    const response = await fetchHandler(
      new Request(`https://mcp.test/callback?code=oauth-code&state=${stateToken}`, {
        headers: { Cookie: setCookie },
      }) as Parameters<typeof fetchHandler>[0],
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(403);
    expect(completeAuthorization).not.toHaveBeenCalled();
    expect(values.has(`device:user:${userCode}`)).toBe(true);
  });

  test("an approved device login notifies loopback and shows no token to the browser", async () => {
    const values = new Map<string, string>([
      ["client:headless-client", clientRecord()],
    ]);
    const kv = testKv(values);
    const started = await start(kv);
    const body = (await started.json()) as { user_code: string };
    const userCode = body.user_code.replace("-", "");
    const oauthReqInfo = {
      clientId: "headless-client",
      codeChallenge: "challenge-from-verifier",
      codeChallengeMethod: "S256" as const,
      redirectUri: "http://127.0.0.1:43123/callback",
      responseType: "code",
      scope: ["mcp:read", "mcp:write"],
      state: `device:${userCode}`,
    };
    const { stateToken } = await createOAuthState(oauthReqInfo, kv);
    const { setCookie } = await bindStateToSession(stateToken);
    const completeAuthorization = vi.fn(async () => ({
      redirectTo:
        "http://127.0.0.1:43123/callback?code=provider-auth-code&state=device",
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
          id: 42,
          login: "allowed",
          name: "Allowed",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const fetchHandler = githubHandler.fetch;
    if (fetchHandler === undefined) {
      throw new Error("GitHub handler does not expose fetch");
    }
    const response = await fetchHandler(
      new Request(`https://mcp.test/callback?code=oauth-code&state=${stateToken}`, {
        headers: { Cookie: setCookie },
      }) as Parameters<typeof fetchHandler>[0],
      {
        api: { fetch: vi.fn() } as unknown as ApiFetcher,
        apiToken: "api-token",
        MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY: "cookie-secret",
        MACHINE_MEMORY_GITHUB_ALLOWED_USER_ID: "42",
        MACHINE_MEMORY_GITHUB_CLIENT_ID: "client-id",
        MACHINE_MEMORY_GITHUB_CLIENT_SECRET: "client-secret",
        OAUTH_KV: kv,
        OAUTH_PROVIDER: {
          completeAuthorization,
        } as unknown as OAuthHelpers,
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).not.toContain("provider-auth-code");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:43123/callback?code=provider-auth-code&state=device",
      { redirect: "manual" },
    );
    expect(values.has(`device:user:${userCode}`)).toBe(false);
  });
});

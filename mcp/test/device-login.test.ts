import { readFile } from "node:fs/promises";

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import {
  claimDeviceApproval,
  finishDeviceApproval,
  readDeviceActivation,
  readDevicePoll,
  rejectDeviceLogin,
  storeDeviceLogin,
} from "../src/auth/device-store";

const ORIGIN = "https://memory.test";
const REDIRECT = "http://127.0.0.1:43123/callback";
const VERIFIER = "a-verifier-kept-only-on-the-headless-machine-12345";
let mf: Miniflare;
let db: D1Database;
let githubUserId = 42;
let challenge: string;
const outbound: string[] = [];

async function bundle(entry: string) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    target: "es2022",
  });
  return result.outputFiles[0].text;
}

beforeAll(async () => {
  challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER)),
  ).toString("base64url");
  const [router, oauth] = await Promise.all([
    bundle("../router/src/index.ts"),
    bundle("test/fixtures/oauth-worker.ts"),
  ]);
  mf = new Miniflare({
    host: "127.0.0.1",
    workers: [
      {
        name: "router",
        modules: true,
        script: router,
        compatibilityDate: "2026-07-30",
        serviceBindings: {
          MCP: "mcp",
          API: async () => new Response("Unexpected API call", { status: 500 }),
        },
      },
      {
        name: "mcp",
        modules: true,
        script: oauth,
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        kvNamespaces: ["OAUTH_KV"],
        d1Databases: ["OAUTH_DEVICES"],
        bindings: {
          apiToken: "test-only",
          MACHINE_MEMORY_GITHUB_CLIENT_ID: "test-client",
          MACHINE_MEMORY_GITHUB_CLIENT_SECRET: "test-secret",
          MACHINE_MEMORY_GITHUB_ALLOWED_USER_ID: "42",
          MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY: "test-cookie-signing-key",
        },
        serviceBindings: {
          api: async () => new Response("Unexpected API call", { status: 500 }),
        },
        outboundService: async (request: Request) => {
          outbound.push(request.url);
          if (request.url === "https://github.com/login/oauth/access_token") {
            return new Response("access_token=github-test-token", {
              headers: { "content-type": "application/x-www-form-urlencoded" },
            });
          }
          if (request.url === "https://api.github.com/user") {
            return Response.json({
              id: githubUserId,
              login: "test-user",
              name: "Test",
              email: "test@example.com",
            });
          }
          throw new Error(`Unexpected outbound fetch: ${request.url}`);
        },
      },
    ],
  });
  db = (await mf.getD1Database(
    "OAUTH_DEVICES",
    "mcp",
  )) as unknown as D1Database;
  const migration = await readFile(
    "../iac/oauth-migrations/0001_device_sessions.sql",
    "utf8",
  );
  await db.batch(
    migration
      .split(";")
      .map((sql) => sql.trim())
      .filter(Boolean)
      .map((sql) => db.prepare(sql)),
  );
}, 30_000);

afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  githubUserId = 42;
  outbound.length = 0;
  vi.restoreAllMocks();
  await db.prepare("DELETE FROM device_sessions").run();
});

async function request(
  path: string,
  body?: Record<string, string>,
  cookie?: string,
) {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  if (body) headers.set("content-type", "application/x-www-form-urlencoded");
  return mf.dispatchFetch(`${ORIGIN}${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? new URLSearchParams(body).toString() : undefined,
    redirect: "manual",
  });
}

async function register() {
  const response = await mf.dispatchFetch(`${ORIGIN}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Headless integration test",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function start(overrides: Record<string, string> = {}) {
  const clientId = await register();
  const response = await request("/device/start", {
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
    ...overrides,
  });
  return { clientId, response };
}

type Session = { user_code: string; device_code: string; clientId: string };
async function session(): Promise<Session> {
  const { clientId, response } = await start();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as Session;
  return { ...body, clientId };
}

function hidden(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  expect(match, `missing ${name} in ${html}`).not.toBeNull();
  return match![1];
}

async function consent(login: Session, mutate?: (auth: AuthRequest) => void) {
  const page = await request("/activate");
  const form = await page.text();
  const activation = await request(
    "/activate",
    {
      user_code: login.user_code.toLowerCase(),
      csrf_token: hidden(form, "csrf_token"),
    },
    page.headers.get("set-cookie")!,
  );
  expect(activation.status).toBe(200);
  const html = await activation.text();
  const state = JSON.parse(atob(hidden(html, "state"))) as {
    oauthReqInfo: AuthRequest;
  };
  mutate?.(state.oauthReqInfo);
  const approval = await request(
    "/authorize",
    {
      state: btoa(JSON.stringify(state)),
      csrf_token: hidden(html, "csrf_token"),
    },
    activation.headers.get("set-cookie")!,
  );
  expect(approval.status).toBe(302);
  expect(approval.headers.getSetCookie()).toHaveLength(2);
  const upstream = new URL(approval.headers.get("location")!);
  const cookie = approval.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { state: upstream.searchParams.get("state")!, cookie };
}

async function callback(
  approval: Awaited<ReturnType<typeof consent>>,
  denied = false,
) {
  return request(
    `/callback?state=${approval.state}&${denied ? "error=access_denied" : "code=github-code"}`,
    undefined,
    approval.cookie,
  );
}

async function poll(login: Session) {
  return request("/device/poll", {
    client_id: login.clientId,
    device_code: login.device_code,
  });
}

describe("headless login through the public router and real OAuth provider", () => {
  test("approves without loopback, retrieves once, exchanges with PKCE, and authenticates MCP", async () => {
    const login = await session();
    const stored = JSON.stringify(
      (await db.prepare("SELECT * FROM device_sessions").all()).results,
    );
    expect(stored).not.toContain(login.user_code.replace("-", ""));
    expect(stored).not.toContain(login.device_code);
    expect(await (await poll(login)).json()).toEqual({
      error: "authorization_pending",
    });
    const approved = await callback(await consent(login));
    expect(approved.status).toBe(200);
    expect(approved.headers.get("location")).toBeNull();
    expect(await approved.text()).toContain("Approved");
    expect(outbound).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
    ]);
    // Advance only the rate-limit deadline, not session expiry.
    await db.prepare("UPDATE device_sessions SET next_poll_at = 0").run();
    const response = await poll(login);
    expect(response.status).toBe(200);
    const { code } = (await response.json()) as { code: string };
    expect(code).toBeTruthy();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await (await poll(login)).json()).toEqual({
      error: "expired_token",
    });
    const tokenBody = {
      grant_type: "authorization_code",
      client_id: login.clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource: `${ORIGIN}/mcp`,
    };
    const wrong = await request("/token", {
      ...tokenBody,
      code_verifier: "wrong-verifier",
    });
    expect(wrong.status).toBe(400);
    const tokenResponse = await request("/token", tokenBody);
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    const initialized = await mf.dispatchFetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "headless-test", version: "1" },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain("protocolVersion");
    // Replaying an authorization code revokes the provider grant, so test
    // replay only after demonstrating that its token can authenticate MCP.
    expect((await request("/token", tokenBody)).status).toBe(400);
  });

  test.each<Record<string, string>>([
    { code_challenge: "short" },
    { code_challenge_method: "plain" },
    { redirect_uri: "https://unregistered.example/callback" },
    { scope: "admin" },
  ])(
    "rejects invalid start parameters %j without storing a session",
    async (input) => {
      const { response } = await start(input);
      expect(response.status).toBe(400);
      expect(
        await db
          .prepare("SELECT count(*) AS count FROM device_sessions")
          .first("count"),
      ).toBe(0);
    },
  );

  test("activation requires CSRF protection", async () => {
    const login = await session();
    expect(
      (await request("/activate", { user_code: login.user_code })).status,
    ).toBe(403);
  });

  test("persistence failure never reports approval or leaves polling pending", async () => {
    const login = await session();
    const approval = await consent(login);
    await db
      .prepare(`CREATE TRIGGER fail_approval BEFORE UPDATE OF status ON device_sessions
      WHEN NEW.status = 'approved' BEGIN SELECT RAISE(FAIL, 'injected write failure'); END`)
      .run();
    try {
      const response = await callback(approval);
      expect(response.status).toBe(500);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).not.toContain("Approved");
      expect(await (await poll(login)).json()).toEqual({
        error: "server_error",
      });
    } finally {
      await db.prepare("DROP TRIGGER fail_approval").run();
    }
  });

  test.each(["github", "allowlist"])(
    "propagates %s denial to polling",
    async (reason) => {
      const login = await session();
      const approval = await consent(login);
      if (reason === "allowlist") githubUserId = 43;
      expect((await callback(approval, reason === "github")).status).toBe(403);
      expect(await (await poll(login)).json()).toEqual({
        error: "access_denied",
      });
    },
  );

  test.each(["expired", "used", "scope", "pkce", "resource"])(
    "fails closed for %s device approval",
    async (reason) => {
      const login = await session();
      const approval = await consent(login, (auth) => {
        if (reason === "scope") auth.scope = ["mcp:read"];
        if (reason === "pkce") auth.codeChallenge = "x".repeat(43);
        if (reason === "resource") auth.resource = "https://other.example/mcp";
      });
      if (reason === "expired")
        await db.prepare("UPDATE device_sessions SET expires_at = 0").run();
      if (reason === "used")
        await db
          .prepare("UPDATE device_sessions SET status = 'approving'")
          .run();
      const response = await callback(approval);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(
        await db
          .prepare("SELECT authorization_code FROM device_sessions")
          .first("authorization_code"),
      ).toBeNull();
    },
  );
});

describe("atomic D1 device state", () => {
  const auth: AuthRequest = {
    responseType: "code",
    clientId: "client-a",
    redirectUri: REDIRECT,
    scope: ["mcp:read"],
    state: "device:test-session",
    codeChallenge: "x".repeat(43),
    codeChallengeMethod: "S256",
  };

  test("one concurrent claimant and one concurrent recipient win", async () => {
    await storeDeviceLogin(db, auth, "ABCD1234", "secret-a");
    expect(
      (
        await Promise.all([
          claimDeviceApproval(db, auth),
          claimDeviceApproval(db, auth),
        ])
      ).sort(),
    ).toEqual([false, true]);
    expect(await readDevicePoll(db, "wrong-secret", auth.clientId)).toEqual({
      error: "expired_token",
    });
    expect(await readDevicePoll(db, "secret-a", "wrong-client")).toEqual({
      error: "expired_token",
    });
    expect(await finishDeviceApproval(db, auth.state, "real-code")).toBe(true);
    const polls = await Promise.all([
      readDevicePoll(db, "secret-a", auth.clientId),
      readDevicePoll(db, "secret-a", auth.clientId),
    ]);
    expect(polls.filter((value) => "code" in value)).toEqual([
      { code: "real-code" },
    ]);
    expect(
      await db
        .prepare("SELECT count(*) FROM device_sessions")
        .first("count(*)"),
    ).toBe(0);
  });

  test("expiry and poll interval enforce both sides of their boundaries", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    await storeDeviceLogin(db, auth, "ABCD1234", "secret-a");
    expect(await readDevicePoll(db, "secret-a", auth.clientId)).toEqual({
      error: "authorization_pending",
    });
    vi.spyOn(Date, "now").mockReturnValue(104_999);
    expect(await readDevicePoll(db, "secret-a", auth.clientId)).toEqual({
      error: "slow_down",
    });
    vi.spyOn(Date, "now").mockReturnValue(105_000);
    expect(await readDevicePoll(db, "secret-a", auth.clientId)).toEqual({
      error: "authorization_pending",
    });
    vi.spyOn(Date, "now").mockReturnValue(699_999);
    expect(await readDeviceActivation(db, "ABCD1234")).toEqual(auth);
    vi.spyOn(Date, "now").mockReturnValue(700_000);
    expect(await readDeviceActivation(db, "ABCD1234")).toBeNull();
    expect(await claimDeviceApproval(db, auth)).toBe(false);
    expect(await readDevicePoll(db, "secret-a", auth.clientId)).toEqual({
      error: "expired_token",
    });
  });

  test("collisions cannot overwrite a session and failed issuance is terminal", async () => {
    expect(await storeDeviceLogin(db, auth, "ABCD1234", "secret-a")).toBe(true);
    expect(
      await storeDeviceLogin(
        db,
        { ...auth, state: "device:other" },
        "ABCD1234",
        "secret-b",
      ),
    ).toBe(false);
    expect(await readDeviceActivation(db, "ABCD1234")).toEqual(auth);
    expect(await claimDeviceApproval(db, auth)).toBe(true);
    await rejectDeviceLogin(db, auth, "failed");
    expect(await readDevicePoll(db, "secret-a", auth.clientId)).toEqual({
      error: "server_error",
    });
    expect(await finishDeviceApproval(db, auth.state, "late-code")).toBe(false);
  });
});

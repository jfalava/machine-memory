import { Schema } from "effect";

/**
 * Headless MCP login. The client starts a pending session and prints a short
 * code. A person enters that code at `/activate`, which reuses the GitHub
 * login. Approval completes the provider's authorization-code grant against a
 * loopback redirect the client is already listening on, so token issuance
 * stays inside `@cloudflare/workers-oauth-provider` instead of a parallel
 * minter. The code is an approval handle, never a bearer token.
 */

export const DEVICE_GRANT_TYPE = "urn:machine-memory:grant-type:device-code";
export const ACTIVATE_PATH = "/activate";
export const DEVICE_START_PATH = "/device/start";
export const DEVICE_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 8;

const DeviceRecordSchema = Schema.Struct({
  clientId: Schema.String,
  codeChallenge: Schema.String,
  redirectUri: Schema.String,
  scope: Schema.mutable(Schema.Array(Schema.String)),
  secretHash: Schema.String,
  status: Schema.Literals(["pending", "denied"]),
});

export type DeviceRecord = {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly scope: readonly string[];
  readonly secretHash: string;
  readonly status: "pending" | "denied";
};

type RegisteredClient = {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly tokenEndpointAuthMethod: string;
};

type DeviceStart = {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_in: number;
  readonly interval: number;
};

export type DeviceLoginResult =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "redirect"; readonly location: string };

function oauthError(
  error: string,
  description: string,
  status: number,
): Response {
  return Response.json(
    { error, error_description: description },
    {
      status,
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    },
  );
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "X-Frame-Options": "DENY",
    },
  });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomUserCode(): string {
  const bytes = new Uint8Array(USER_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (byte) => {
    const index = byte % USER_CODE_ALPHABET.length;
    return USER_CODE_ALPHABET[index] ?? "A";
  });
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export function normalizeUserCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

function formatUserCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

function isLoopbackRedirect(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  return parsed.protocol === "http:" && loopback && parsed.username === "";
}

function redirectMatches(
  requested: string,
  registered: readonly string[],
): boolean {
  return registered.some((candidate) => {
    if (candidate === requested) {
      return true;
    }
    if (!isLoopbackRedirect(requested) || !isLoopbackRedirect(candidate)) {
      return false;
    }
    const left = new URL(requested);
    const right = new URL(candidate);
    return (
      left.protocol === right.protocol &&
      left.hostname === right.hostname &&
      left.pathname === right.pathname &&
      left.search === right.search
    );
  });
}

async function readRegisteredClient(
  kv: KVNamespace,
  clientId: string,
): Promise<RegisteredClient | undefined> {
  const raw = await kv.get(`client:${clientId}`);
  if (raw === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const decoded = Schema.decodeUnknownExit(
    Schema.Struct({
      clientId: Schema.String,
      redirectUris: Schema.Array(Schema.String),
      tokenEndpointAuthMethod: Schema.String,
    }),
  )(parsed);
  if (decoded._tag === "Failure") {
    return undefined;
  }
  return decoded.value;
}

function userKey(userCode: string): string {
  return `device:user:${userCode}`;
}

function secretKey(deviceCodeHash: string): string {
  return `device:secret:${deviceCodeHash}`;
}

async function readRecord(
  kv: KVNamespace,
  key: string,
): Promise<DeviceRecord | undefined> {
  const raw = await kv.get(key);
  if (raw === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const decoded = Schema.decodeUnknownExit(DeviceRecordSchema)(parsed);
  if (decoded._tag === "Failure") {
    return undefined;
  }
  return decoded.value;
}

async function writeRecord(
  kv: KVNamespace,
  userCode: string,
  deviceCodeHash: string,
  record: DeviceRecord,
): Promise<void> {
  const stored = JSON.stringify(record);
  const options = { expirationTtl: DEVICE_TTL_SECONDS };
  await kv.put(userKey(userCode), stored, options);
  await kv.put(secretKey(deviceCodeHash), stored, options);
}

function formValue(form: FormData, name: string): string {
  const value = form.get(name);
  if (value instanceof File || value === null) {
    return "";
  }
  return value.trim();
}

type DeviceStartInput = {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly scope: string;
};

function parseDeviceStart(form: FormData): DeviceStartInput | Response {
  const clientId = formValue(form, "client_id");
  const redirectUri = formValue(form, "redirect_uri");
  const codeChallenge = formValue(form, "code_challenge");
  const codeChallengeMethod = formValue(form, "code_challenge_method");
  if (
    clientId === "" ||
    redirectUri === "" ||
    codeChallenge === "" ||
    codeChallengeMethod !== "S256"
  ) {
    return oauthError(
      "invalid_request",
      "client_id, redirect_uri, and an S256 code_challenge are required.",
      400,
    );
  }
  if (!isLoopbackRedirect(redirectUri)) {
    return oauthError(
      "invalid_request",
      "redirect_uri must be an HTTP loopback URI.",
      400,
    );
  }
  return {
    clientId,
    codeChallenge,
    redirectUri,
    scope: formValue(form, "scope"),
  };
}

async function authorizeDeviceClient(
  kv: KVNamespace,
  input: DeviceStartInput,
): Promise<readonly string[] | Response> {
  const client = await readRegisteredClient(kv, input.clientId);
  if (client === undefined) {
    return oauthError("invalid_client", "Client not found.", 401);
  }
  if (client.tokenEndpointAuthMethod !== "none") {
    return oauthError(
      "invalid_client",
      "Headless login requires a public client.",
      401,
    );
  }
  if (!redirectMatches(input.redirectUri, client.redirectUris)) {
    return oauthError(
      "invalid_request",
      "redirect_uri is not registered for this client.",
      400,
    );
  }
  const scopes =
    input.scope === ""
      ? ["mcp:read", "mcp:write"]
      : input.scope.split(" ").filter(Boolean);
  if (scopes.some((item) => item !== "mcp:read" && item !== "mcp:write")) {
    return oauthError("invalid_scope", "Unsupported scope.", 400);
  }
  return scopes;
}

export async function startDeviceLogin(
  request: Request,
  kv: KVNamespace,
): Promise<Response> {
  if (request.method !== "POST") {
    return oauthError("invalid_request", "POST is required.", 405);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError(
      "invalid_request",
      "Body must be application/x-www-form-urlencoded.",
      400,
    );
  }

  const parsed = parseDeviceStart(form);
  if (parsed instanceof Response) {
    return parsed;
  }
  const scopes = await authorizeDeviceClient(kv, parsed);
  if (scopes instanceof Response) {
    return scopes;
  }

  const deviceCode = crypto.randomUUID();
  const normalized = normalizeUserCode(randomUserCode());
  const secretHash = await sha256Hex(deviceCode);
  await writeRecord(kv, normalized, secretHash, {
    clientId: parsed.clientId,
    codeChallenge: parsed.codeChallenge,
    redirectUri: parsed.redirectUri,
    scope: scopes,
    secretHash,
    status: "pending",
  });

  const body: DeviceStart = {
    device_code: deviceCode,
    expires_in: DEVICE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
    user_code: formatUserCode(normalized),
    verification_uri: new URL(ACTIVATE_PATH, request.url).href,
  };
  return Response.json(body, {
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

async function readActivation(
  request: Request,
  kv: KVNamespace,
): Promise<DeviceRecord | Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return activatePage("Enter the code from the headless client.", 400);
  }
  const normalized = normalizeUserCode(formValue(form, "user_code"));
  if (normalized.length !== USER_CODE_LENGTH) {
    return activatePage("That code is not valid.", 400);
  }
  const record = await readRecord(kv, userKey(normalized));
  if (record === undefined || record.status !== "pending") {
    return activatePage("That code is expired or already used.", 400);
  }
  return { ...record, secretHash: normalized };
}

function activatePage(message: string, status = 200): Response {
  const notice =
    message === ""
      ? ""
      : `<p class="notice">${escapeHtml(message)}</p>`;
  return htmlResponse(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Activate Machine Memory</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f9fafb; color: #333; margin: 0; }
    main { max-width: 32rem; margin: 3rem auto; background: #fff; border-radius: 8px; padding: 2rem; box-shadow: 0 8px 36px rgba(0,0,0,0.08); }
    h1 { font-size: 1.4rem; font-weight: 600; }
    p { line-height: 1.5; }
    label { display: block; font-weight: 500; margin-bottom: 0.5rem; }
    input { width: 100%; box-sizing: border-box; font: 1.4rem ui-monospace, monospace; letter-spacing: 0.12em; text-transform: uppercase; padding: 0.7rem; border: 1px solid #e5e7eb; border-radius: 6px; }
    button { margin-top: 1rem; background: #0070f3; color: #fff; border: 0; border-radius: 6px; padding: 0.75rem 1.25rem; font-size: 1rem; cursor: pointer; }
    .notice { color: #9f1239; }
  </style>
</head>
<body>
  <main>
    <h1>Activate Machine Memory</h1>
    <p>Enter the code shown by the headless client. You will sign in with GitHub before it is approved.</p>
    ${notice}
    <form method="post" action="${ACTIVATE_PATH}">
      <label for="user_code">Code</label>
      <input id="user_code" name="user_code" autocomplete="off" spellcheck="false" required>
      <button type="submit">Continue</button>
    </form>
  </main>
</body>
</html>`,
    status,
  );
}

export async function beginDeviceActivation(
  request: Request,
  kv: KVNamespace,
): Promise<DeviceLoginResult> {
  if (request.method === "GET") {
    return { kind: "response", response: activatePage("") };
  }
  if (request.method !== "POST") {
    return {
      kind: "response",
      response: activatePage("Use the form to continue.", 405),
    };
  }

  const record = await readActivation(request, kv);
  if (record instanceof Response) {
    return { kind: "response", response: record };
  }

  const location = new URL("/authorize", request.url);
  location.searchParams.set("response_type", "code");
  location.searchParams.set("client_id", record.clientId);
  location.searchParams.set("redirect_uri", record.redirectUri);
  location.searchParams.set("code_challenge", record.codeChallenge);
  location.searchParams.set("code_challenge_method", "S256");
  location.searchParams.set("scope", record.scope.join(" "));
  location.searchParams.set("state", `device:${record.secretHash}`);
  return { kind: "redirect", location: location.href };
}

/**
 * Called after GitHub login succeeds for a device-started authorization.
 * Confirms the pending code still matches the client and PKCE challenge, then
 * tells the caller to finish the provider grant. The loopback redirect carries
 * the authorization code to the client that is polling for it.
 */
export async function claimDeviceApproval(
  kv: KVNamespace,
  state: string,
  clientId: string,
  redirectUri: string,
  codeChallenge: string | undefined,
): Promise<boolean> {
  if (!state.startsWith("device:")) {
    return false;
  }
  const userCode = state.slice("device:".length);
  const record = await readRecord(kv, userKey(userCode));
  if (
    record === undefined ||
    record.status !== "pending" ||
    record.clientId !== clientId ||
    record.redirectUri !== redirectUri ||
    record.codeChallenge !== codeChallenge
  ) {
    return false;
  }
  await kv.delete(userKey(userCode));
  await kv.delete(secretKey(record.secretHash));
  return true;
}

export function deviceApprovedPage(): Response {
  return htmlResponse(
    `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Approved</title></head>
<body><main><h1>Approved</h1><p>Return to the headless client. This page did not receive a token.</p></main></body>
</html>`,
  );
}

async function readDevicePoll(
  request: Request,
): Promise<{ deviceCode: string; clientId: string } | Response | undefined> {
  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    return undefined;
  }
  if (form.get("grant_type") !== DEVICE_GRANT_TYPE) {
    return undefined;
  }
  const deviceCode = formValue(form, "device_code");
  const clientId = formValue(form, "client_id");
  if (deviceCode === "" || clientId === "") {
    return oauthError(
      "invalid_request",
      "device_code and client_id are required.",
      400,
    );
  }
  return { clientId, deviceCode };
}

export async function pollDeviceLogin(
  request: Request,
  kv: KVNamespace,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/token" || request.method !== "POST") {
    return undefined;
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return undefined;
  }
  const polled = await readDevicePoll(request);
  if (polled === undefined || polled instanceof Response) {
    return polled;
  }
  const record = await readRecord(
    kv,
    secretKey(await sha256Hex(polled.deviceCode)),
  );
  if (record === undefined || record.clientId !== polled.clientId) {
    return oauthError("expired_token", "The device code has expired.", 400);
  }
  if (record.status === "denied") {
    return oauthError("access_denied", "The sign-in was denied.", 400);
  }
  return oauthError(
    "authorization_pending",
    "Enter the code at the verification page.",
    400,
  );
}

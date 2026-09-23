import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import {
  DEVICE_POLL_INTERVAL_SECONDS,
  DEVICE_STATE_PREFIX,
  DEVICE_TTL_SECONDS,
  readDeviceActivation,
  readDevicePoll,
  storeDeviceLogin,
} from "./device-store";
import {
  generateCSRFProtection,
  sanitizeText,
  validateCSRFToken,
  OAuthError,
} from "./oauth-utils";

export const ACTIVATE_PATH = "/activate";
export const DEVICE_START_PATH = "/device/start";
export const DEVICE_POLL_PATH = "/device/poll";

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };
// 32 symbols, so each random byte maps without modulo bias.
const USER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomUserCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    USER_CODE_ALPHABET.charAt(byte % USER_CODE_ALPHABET.length),
  ).join("");
}

function formValue(form: FormData, name: string): string {
  const value = form.get(name);
  return value === null || value instanceof File ? "" : value.trim();
}

function oauthError(
  error: string,
  description: string,
  status = 400,
): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: NO_STORE },
  );
}

async function readForm(request: Request): Promise<FormData | Response> {
  if (request.method !== "POST") {
    return oauthError("invalid_request", "POST is required.", 405);
  }
  if (
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  ) {
    return oauthError(
      "invalid_request",
      "Body must be application/x-www-form-urlencoded.",
    );
  }
  try {
    return await request.formData();
  } catch {
    return oauthError("invalid_request", "Invalid form body.");
  }
}

async function deviceAuthRequest(
  request: Request,
  form: FormData,
  helpers: OAuthHelpers,
): Promise<AuthRequest | Response> {
  const clientId = formValue(form, "client_id");
  const challenge = formValue(form, "code_challenge");
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    formValue(form, "code_challenge_method") !== "S256"
  ) {
    return oauthError(
      "invalid_request",
      "A valid S256 code_challenge is required.",
    );
  }
  const client = await helpers.lookupClient(clientId);
  if (client === null || client.tokenEndpointAuthMethod !== "none") {
    return oauthError(
      "invalid_client",
      "A registered public client is required.",
      401,
    );
  }
  const scope = formValue(form, "scope") || "mcp:read mcp:write";
  if (
    scope
      .split(" ")
      .filter(Boolean)
      .some((item) => item !== "mcp:read" && item !== "mcp:write")
  ) {
    return oauthError("invalid_scope", "Unsupported scope.");
  }
  const url = new URL("/authorize", request.url);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: formValue(form, "redirect_uri"),
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    state: `${DEVICE_STATE_PREFIX}${crypto.randomUUID()}`,
  }).toString();
  for (const resource of form.getAll("resource")) {
    if (!(resource instanceof File)) {
      url.searchParams.append("resource", resource);
    }
  }
  // Delegate redirect, PKCE, resource and client capability validation to the
  // provider. Never follow its redirect here: this endpoint is machine-facing.
  try {
    return await helpers.parseAuthRequest(new Request(url));
  } catch (error) {
    if (error instanceof Error && error.name === "AuthorizationError") {
      return oauthError("invalid_request", "Invalid authorization request.");
    }
    throw error;
  }
}

export async function startDeviceLogin(
  request: Request,
  db: D1Database,
  helpers: OAuthHelpers,
): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) {
    return form;
  }
  const auth = await deviceAuthRequest(request, form, helpers);
  if (auth instanceof Response) {
    return auth;
  }
  const deviceCode = crypto.randomUUID();
  let userCode: string;
  do {
    userCode = randomUserCode();
  } while (!(await storeDeviceLogin(db, auth, userCode, deviceCode)));
  return Response.json(
    {
      device_code: deviceCode,
      user_code: `${userCode.slice(0, 4)}-${userCode.slice(4)}`,
      verification_uri: new URL(ACTIVATE_PATH, request.url).href,
      expires_in: DEVICE_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    },
    { headers: NO_STORE },
  );
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      ...NO_STORE,
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function activatePage(message = "", status = 200): Response {
  const csrf = generateCSRFProtection();
  const response = htmlResponse(
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
    ${message === "" ? "" : `<p class="notice">${sanitizeText(message)}</p>`}
    <form method="post" action="${ACTIVATE_PATH}">
      <input type="hidden" name="csrf_token" value="${csrf.token}">
      <label for="user_code">Code</label>
      <input id="user_code" name="user_code" autocomplete="off" spellcheck="false" required>
      <button type="submit">Continue</button>
    </form>
  </main>
</body>
</html>`,
    status,
  );
  response.headers.set("Set-Cookie", csrf.setCookie);
  return response;
}

export async function beginDeviceActivation(
  request: Request,
  db: D1Database,
): Promise<AuthRequest | Response> {
  if (request.method === "GET") {
    return activatePage();
  }
  const form = await readForm(request);
  if (form instanceof Response) {
    return form;
  }
  try {
    validateCSRFToken(form, request);
  } catch (error) {
    if (error instanceof OAuthError) {
      return activatePage("Reload the form and try again.", 403);
    }
    throw error;
  }
  const userCode = formValue(form, "user_code")
    .replace(/[\s-]/g, "")
    .toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(userCode)) {
    return activatePage("That code is not valid.", 400);
  }
  const auth = await readDeviceActivation(db, userCode);
  return auth ?? activatePage("That code is expired or already used.", 400);
}

export function deviceApprovedPage(): Response {
  return htmlResponse(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Approved</title></head>
<body><main><h1>Approved</h1><p>Return to the headless client. This page did not receive a token.</p></main></body>
</html>`);
}

export async function pollDeviceLogin(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) {
    return form;
  }
  const deviceCode = formValue(form, "device_code");
  const clientId = formValue(form, "client_id");
  if (deviceCode === "" || clientId === "") {
    return oauthError(
      "invalid_request",
      "device_code and client_id are required.",
    );
  }
  const result = await readDevicePoll(db, deviceCode, clientId);
  const status =
    "error" in result ? (result.error === "server_error" ? 500 : 400) : 200;
  return Response.json(result, { status, headers: NO_STORE });
}

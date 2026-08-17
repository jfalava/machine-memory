import type {
  AuthRequest,
  ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { Schema } from "effect";

/**
 * OAuth 2.1 compliant error class with standardized error codes and
 * descriptions.
 */
export class OAuthError extends Error {
  constructor(
    public code: string,
    public description: string,
    public statusCode = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }

  toResponse(): Response {
    return new Response(
      JSON.stringify({
        error: this.code,
        error_description: this.description,
      }),
      {
        status: this.statusCode,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

export function sanitizeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function sanitizeUrl(url: string): string {
  const normalized = url.trim();

  if (normalized.length === 0) {
    return "";
  }

  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      return "";
    }
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalized);
  } catch {
    return "";
  }

  const allowedSchemes = ["https", "http"];
  const scheme = parsedUrl.protocol.slice(0, -1).toLowerCase();
  if (!allowedSchemes.includes(scheme)) {
    return "";
  }

  return normalized;
}

const CSRF_COOKIE_NAME = "__Host-CSRF_TOKEN";
const CONSENTED_STATE_COOKIE_NAME = "__Host-CONSENTED_STATE";
const APPROVED_CLIENTS_COOKIE_NAME = "__Host-APPROVED_CLIENTS";
const THIRTY_DAYS_IN_SECONDS = 2592000;
const STATE_TTL_SECONDS = 600;

type CSRFProtection = {
  readonly token: string;
  readonly setCookie: string;
};

type CSRFValidation = {
  readonly clearCookie: string;
};

function csrfCookieValue(value: string): string {
  return `${CSRF_COOKIE_NAME}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
}

export function generateCSRFProtection(): CSRFProtection {
  const token = crypto.randomUUID();
  return {
    token,
    setCookie: csrfCookieValue(token),
  };
}

export function validateCSRFToken(
  formData: FormData,
  request: Request,
): CSRFValidation {
  const tokenFromForm = formData.get("csrf_token");
  if (tokenFromForm === null || tokenFromForm instanceof File) {
    throw new OAuthError(
      "invalid_request",
      "Missing CSRF token in form data",
      400,
    );
  }

  const cookieHeader = request.headers.get("Cookie") ?? "";
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const csrfCookie = cookies.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`));
  const tokenFromCookie = csrfCookie
    ? csrfCookie.substring(CSRF_COOKIE_NAME.length + 1)
    : null;

  if (tokenFromCookie === null || tokenFromCookie === "") {
    throw new OAuthError("invalid_request", "Missing CSRF token cookie", 400);
  }

  if (tokenFromForm !== tokenFromCookie) {
    throw new OAuthError("invalid_request", "CSRF token mismatch", 400);
  }

  const clearCookie = `${CSRF_COOKIE_NAME}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
  return { clearCookie };
}

type OAuthState = {
  readonly stateToken: string;
};

type SessionBinding = {
  readonly setCookie: string;
};

export async function createOAuthState(
  oauthReqInfo: AuthRequest,
  kv: KVNamespace,
  stateTTL = STATE_TTL_SECONDS,
): Promise<OAuthState> {
  const stateToken = crypto.randomUUID();
  await kv.put(`oauth:state:${stateToken}`, JSON.stringify(oauthReqInfo), {
    expirationTtl: stateTTL,
  });
  return { stateToken };
}

export async function bindStateToSession(
  stateToken: string,
): Promise<SessionBinding> {
  const hashHex = await sha256Hex(stateToken);
  const setCookie = `${CONSENTED_STATE_COOKIE_NAME}=${hashHex}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
  return { setCookie };
}

type ValidatedState = {
  readonly oauthReqInfo: AuthRequest;
  readonly clearCookie: string;
};

function parseStoredState(value: string): AuthRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new OAuthError("server_error", "Invalid state data", 500);
  }
  return Schema.decodeUnknownSync(Schema.Any)(parsed) as AuthRequest;
}

function sessionStateHash(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const consentedStateCookie = cookies.find((c) =>
    c.startsWith(`${CONSENTED_STATE_COOKIE_NAME}=`),
  );
  if (consentedStateCookie === undefined) {
    return null;
  }
  return consentedStateCookie.substring(CONSENTED_STATE_COOKIE_NAME.length + 1);
}

function clearSessionCookie(): string {
  return `${CONSENTED_STATE_COOKIE_NAME}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

export async function validateOAuthState(
  request: Request,
  kv: KVNamespace,
): Promise<ValidatedState> {
  const url = new URL(request.url);
  const stateFromQuery = url.searchParams.get("state");
  if (stateFromQuery === null || stateFromQuery === "") {
    throw new OAuthError("invalid_request", "Missing state parameter", 400);
  }

  const storedDataJson = await kv.get(`oauth:state:${stateFromQuery}`);
  if (storedDataJson === null) {
    throw new OAuthError("invalid_request", "Invalid or expired state", 400);
  }

  const consentedStateHash = sessionStateHash(request);
  if (consentedStateHash === null || consentedStateHash === "") {
    throw new OAuthError(
      "invalid_request",
      "Missing session binding cookie - authorization flow must be restarted",
      400,
    );
  }

  const stateHash = await sha256Hex(stateFromQuery);
  if (stateHash !== consentedStateHash) {
    throw new OAuthError(
      "invalid_request",
      "State token does not match session - possible CSRF attack detected",
      400,
    );
  }

  const oauthReqInfo = parseStoredState(storedDataJson);
  await kv.delete(`oauth:state:${stateFromQuery}`);
  return { oauthReqInfo, clearCookie: clearSessionCookie() };
}

export async function isClientApproved(
  request: Request,
  clientId: string,
  cookieSecret: string,
): Promise<boolean> {
  const approvedClients = await getApprovedClientsFromCookie(
    request,
    cookieSecret,
  );
  return approvedClients?.includes(clientId) ?? false;
}

export async function addApprovedClient(
  request: Request,
  clientId: string,
  cookieSecret: string,
): Promise<string> {
  const existingApprovedClients =
    (await getApprovedClientsFromCookie(request, cookieSecret)) ?? [];
  const updatedApprovedClients = Array.from(
    new Set([...existingApprovedClients, clientId]),
  );

  const payload = JSON.stringify(updatedApprovedClients);
  const signature = await signData(payload, cookieSecret);
  const cookieValue = `${signature}.${btoa(payload)}`;

  return `${APPROVED_CLIENTS_COOKIE_NAME}=${cookieValue}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${THIRTY_DAYS_IN_SECONDS}`;
}

function approvedClientsFromCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (cookieHeader === null) {
    return null;
  }
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const targetCookie = cookies.find((c) =>
    c.startsWith(`${APPROVED_CLIENTS_COOKIE_NAME}=`),
  );
  if (targetCookie === undefined) {
    return null;
  }
  return targetCookie.substring(APPROVED_CLIENTS_COOKIE_NAME.length + 1);
}

const ApprovedClientsSchema = Schema.mutable(Schema.Array(Schema.String));

function parseApprovedClients(payload: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Invalid approved clients payload.");
  }
  return [...Schema.decodeUnknownSync(ApprovedClientsSchema)(parsed)];
}

async function getApprovedClientsFromCookie(
  request: Request,
  cookieSecret: string,
): Promise<string[] | null> {
  const cookieValue = approvedClientsFromCookie(request);
  if (cookieValue === null) {
    return null;
  }
  const parts = cookieValue.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const signatureHex = parts[0] ?? "";
  const base64Payload = parts[1] ?? "";
  const payload = atob(base64Payload);

  const isValid = await verifySignature(signatureHex, payload, cookieSecret);
  if (!isValid) {
    return null;
  }
  try {
    return parseApprovedClients(payload);
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(value),
  );
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function importKey(secret: string): Promise<CryptoKey> {
  if (secret === "") {
    throw new Error("cookieSecret is required for signing cookies");
  }
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

async function signData(data: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const enc = new TextEncoder();
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(data),
  );
  return Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifySignature(
  signatureHex: string,
  data: string,
  secret: string,
): Promise<boolean> {
  const key = await importKey(secret);
  const enc = new TextEncoder();
  try {
    const signatureBytes = new Uint8Array(
      (signatureHex.match(/.{1,2}/g) ?? []).map((byte) =>
        Number.parseInt(byte, 16),
      ),
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes.buffer,
      enc.encode(data),
    );
  } catch {
    return false;
  }
}

export interface ApprovalDialogOptions {
  client: ClientInfo | null;
  server: {
    name: string;
    logo?: string;
    description?: string;
  };
  state: { oauthReqInfo: AuthRequest };
  csrfToken: string;
  setCookie: string;
}

function clientLinkRow(label: string, uri: string): string {
  return `<div class="client-detail"><div class="detail-label">${label}:</div><div class="detail-value small"><a href="${uri}" target="_blank" rel="noopener noreferrer">${uri}</a></div></div>`;
}

function safeClientUris(uris: string[] | undefined): string[] {
  if (uris === undefined || uris.length === 0) {
    return [];
  }
  return uris
    .map((uri) => {
      const validated = sanitizeUrl(uri);
      return validated ? sanitizeText(validated) : "";
    })
    .filter((uri) => uri !== "");
}

function optionalUriRows(client: ClientInfo | null): string[] {
  const rows = [
    client?.clientUri
      ? clientLinkRow("Website", sanitizeText(sanitizeUrl(client.clientUri)))
      : "",
    client?.policyUri
      ? clientLinkRow(
          "Privacy Policy",
          sanitizeText(sanitizeUrl(client.policyUri)),
        )
      : "",
    client?.tosUri
      ? clientLinkRow(
          "Terms of Service",
          sanitizeText(sanitizeUrl(client.tosUri)),
        )
      : "",
  ];
  return rows.filter((row) => row !== "");
}

function redirectUrisRow(uris: string[]): string {
  return `<div class="client-detail"><div class="detail-label">Redirect URIs:</div><div class="detail-value small">${uris.map((uri) => `<div>${uri}</div>`).join("")}</div></div>`;
}

function contactsRow(contacts: string): string {
  return `<div class="client-detail"><div class="detail-label">Contact:</div><div class="detail-value">${contacts}</div></div>`;
}

function clientDetailRows(options: ApprovalDialogOptions): string {
  const { client } = options;
  const clientName = client?.clientName
    ? sanitizeText(client.clientName)
    : "Unknown MCP Client";
  const contacts =
    client?.contacts !== undefined && client.contacts.length > 0
      ? sanitizeText(client.contacts.join(", "))
      : "";
  const redirectUris = safeClientUris(client?.redirectUris);

  const rows = [
    `<div class="client-detail"><div class="detail-label">Name:</div><div class="detail-value">${clientName}</div></div>`,
    ...optionalUriRows(client),
  ];
  if (redirectUris.length > 0) {
    rows.push(redirectUrisRow(redirectUris));
  }
  if (contacts !== "") {
    rows.push(contactsRow(contacts));
  }
  return rows.join("\n");
}

function approvalPage(options: ApprovalDialogOptions): string {
  const { client, server, state, csrfToken } = options;
  const serverName = sanitizeText(server.name);
  const clientName = client?.clientName
    ? sanitizeText(client.clientName)
    : "Unknown MCP Client";
  const serverDescription = server.description
    ? sanitizeText(server.description)
    : "";
  const logoUrl = server.logo ? sanitizeText(sanitizeUrl(server.logo)) : "";
  const encodedState = btoa(JSON.stringify(state));

  return `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${clientName} | Authorization Request</title>
        <style>
          :root { --primary-color: #0070f3; --border-color: #e5e7eb; --text-color: #333; }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: var(--text-color); background-color: #f9fafb; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 2rem auto; padding: 1rem; }
          .precard { padding: 2rem; text-align: center; }
          .card { background-color: #fff; border-radius: 8px; box-shadow: 0 8px 36px 8px rgba(0,0,0,0.1); padding: 2rem; }
          .header { display: flex; align-items: center; justify-content: center; margin-bottom: 1.5rem; }
          .logo { width: 48px; height: 48px; margin-right: 1rem; border-radius: 8px; object-fit: contain; }
          .title { margin: 0; font-size: 1.3rem; font-weight: 400; }
          .description { color: #555; }
          .client-info { border: 1px solid var(--border-color); border-radius: 6px; padding: 1rem 1rem 0.5rem; margin-bottom: 1.5rem; }
          .client-detail { display: flex; margin-bottom: 0.5rem; align-items: baseline; }
          .detail-label { font-weight: 500; min-width: 120px; }
          .detail-value { font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace; word-break: break-all; }
          .detail-value.small { font-size: 0.8em; }
          .actions { display: flex; justify-content: flex-end; gap: 1rem; margin-top: 2rem; }
          .button { padding: 0.75rem 1.5rem; border-radius: 6px; font-weight: 500; cursor: pointer; border: none; font-size: 1rem; }
          .button-primary { background-color: var(--primary-color); color: white; }
          .button-secondary { background-color: transparent; border: 1px solid var(--border-color); color: var(--text-color); }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="precard">
            <div class="header">
              ${logoUrl ? `<img src="${logoUrl}" alt="${serverName} Logo" class="logo">` : ""}
              <h1 class="title"><strong>${serverName}</strong></h1>
            </div>
            ${serverDescription ? `<p class="description">${serverDescription}</p>` : ""}
          </div>
          <div class="card">
            <h2><strong>${clientName}</strong> is requesting access</h2>
            <div class="client-info">
              ${clientDetailRows(options)}
            </div>
            <p>This MCP Client is requesting to be authorized on ${serverName}. If you approve, you will be redirected to complete authentication.</p>
            <form method="post" action="/authorize">
              <input type="hidden" name="state" value="${encodedState}">
              <input type="hidden" name="csrf_token" value="${csrfToken}">
              <div class="actions">
                <button type="button" class="button button-secondary" onclick="window.history.back()">Cancel</button>
                <button type="submit" class="button button-primary">Approve</button>
              </div>
            </form>
          </div>
        </div>
      </body>
    </html>`;
}

export function renderApprovalDialog(
  request: Request,
  options: ApprovalDialogOptions,
): Response {
  return new Response(approvalPage(options), {
    headers: {
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": options.setCookie,
      "X-Frame-Options": "DENY",
    },
  });
}

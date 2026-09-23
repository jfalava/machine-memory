import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { Schema } from "effect";

import { AuthRequestSchema, sha256Hex } from "./oauth-utils";

export const DEVICE_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
export const DEVICE_STATE_PREFIX = "device:";

// Explicit field order binds the complete request, independent of JSON key order.
function serializeRequest(request: AuthRequest): string {
  return JSON.stringify({
    responseType: request.responseType,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    scope: request.scope,
    state: request.state,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    resource: request.resource,
    issuer: request.issuer,
  });
}

export async function storeDeviceLogin(
  db: D1Database,
  request: AuthRequest,
  userCode: string,
  deviceCode: string,
): Promise<boolean> {
  const [userHash, deviceHash] = await Promise.all([
    sha256Hex(userCode),
    sha256Hex(deviceCode),
  ]);
  // Cleanup is indexed and shares the insertion transaction. Expiry is also
  // checked on every access, so idle rows can never extend a session's lifetime.
  const results = await db.batch([
    db
      .prepare("DELETE FROM device_sessions WHERE expires_at <= ?")
      .bind(Date.now()),
    db
      .prepare(`INSERT INTO device_sessions
      (id, user_code_hash, device_code_hash, client_id, request, expires_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_code_hash) DO NOTHING`)
      .bind(
        request.state,
        userHash,
        deviceHash,
        request.clientId,
        serializeRequest(request),
        Date.now() + DEVICE_TTL_SECONDS * 1000,
      ),
  ]);
  return results[1].meta.changes === 1;
}

export async function readDeviceActivation(
  db: D1Database,
  userCode: string,
): Promise<AuthRequest | null> {
  const row = await db
    .prepare(`SELECT request FROM device_sessions
    WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?`)
    .bind(await sha256Hex(userCode), Date.now())
    .first<{ request: string }>();
  return row === null
    ? null
    : Schema.decodeUnknownSync(Schema.fromJsonString(AuthRequestSchema))(
        row.request,
      );
}

/** The conditional update, not a preceding read, owns the single-use claim. */
export async function claimDeviceApproval(
  db: D1Database,
  request: AuthRequest,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE device_sessions SET status = 'approving'
    WHERE id = ? AND request = ? AND status = 'pending' AND expires_at > ?`)
    .bind(request.state, serializeRequest(request), Date.now())
    .run();
  return result.meta.changes === 1;
}

export async function finishDeviceApproval(
  db: D1Database,
  state: string,
  code: string,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE device_sessions
    SET status = 'approved', authorization_code = ?
    WHERE id = ? AND status = 'approving' AND expires_at > ?`)
    .bind(code, state, Date.now())
    .run();
  return result.meta.changes === 1;
}

export async function rejectDeviceLogin(
  db: D1Database,
  request: AuthRequest,
  status: "denied" | "failed",
): Promise<void> {
  await db
    .prepare(`UPDATE device_sessions SET status = ?
    WHERE id = ? AND request = ? AND status = ? AND expires_at > ?`)
    .bind(
      status,
      request.state,
      serializeRequest(request),
      status === "denied" ? "pending" : "approving",
      Date.now(),
    )
    .run();
}

type PollResult =
  | { code: string }
  | {
      error:
        | "expired_token"
        | "slow_down"
        | "authorization_pending"
        | "access_denied"
        | "server_error";
    };

export async function readDevicePoll(
  db: D1Database,
  deviceCode: string,
  clientId: string,
): Promise<PollResult> {
  const hash = await sha256Hex(deviceCode);
  const now = Date.now();
  const row = await db
    .prepare(`UPDATE device_sessions SET next_poll_at = ?
    WHERE device_code_hash = ? AND client_id = ? AND expires_at > ? AND next_poll_at <= ?
    RETURNING status`)
    .bind(now + DEVICE_POLL_INTERVAL_SECONDS * 1000, hash, clientId, now, now)
    .first<{ status: string }>();
  if (row === null) {
    const exists = await db
      .prepare(`SELECT 1 FROM device_sessions
      WHERE device_code_hash = ? AND client_id = ? AND expires_at > ?`)
      .bind(hash, clientId, now)
      .first();
    return { error: exists === null ? "expired_token" : "slow_down" };
  }
  if (row.status === "denied") {
    return { error: "access_denied" };
  }
  if (row.status === "failed") {
    return { error: "server_error" };
  }
  if (row.status !== "approved") {
    return { error: "authorization_pending" };
  }
  // The code is disclosed once, only to the holder of the device secret.
  const approved = await db
    .prepare(`DELETE FROM device_sessions
    WHERE device_code_hash = ? AND client_id = ? AND status = 'approved' AND expires_at > ?
    RETURNING authorization_code`)
    .bind(hash, clientId, Date.now())
    .first<{ authorization_code: string }>();
  return approved === null
    ? { error: "expired_token" }
    : { code: approved.authorization_code };
}

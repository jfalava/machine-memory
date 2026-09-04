import { Schema } from "effect";

import type { JsonValue } from "./json";

/**
 * Encode a domain value to its wire JSON shape.
 * Server-side: fail closed — a SchemaError means we almost shipped garbage.
 */
export function encodeResponse<S extends Schema.Top>(
  schema: S,
  value: S["Type"],
): S["Encoded"] {
  // SAFETY: wire schemas in this package are pure data codecs (no services).
  return Schema.encodeSync(schema as never)(value as never) as S["Encoded"];
}

/**
 * Decode wire JSON into a domain value.
 * Client-side helper: returns undefined and logs on failure (graceful).
 */
export function decodeResponse<S extends Schema.Top>(
  schema: S,
  body: JsonValue,
  label: string,
): S["Type"] | undefined {
  try {
    // SAFETY: wire schemas in this package are pure data codecs (no services).
    return Schema.decodeUnknownSync(schema as never)(body) as S["Type"];
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(
      `[machine-memory/contract] decode failed:${label}:${message}`,
    );
    return undefined;
  }
}

/** Pull a readable message out of a thrown SchemaError or Error. */
export function schemaErrorMessage(
  cause: unknown,
  fallback = "Invalid request.",
): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

export type DecodeResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

/**
 * Server-side request decode: fail closed with a stable error string for HTTP 400.
 * `body` is already-parsed JSON from the HTTP layer.
 */
export function decodeRequest<S extends Schema.Top>(
  schema: S,
  body: JsonValue,
): DecodeResult<S["Type"]> {
  try {
    // SAFETY: wire schemas in this package are pure data codecs (no services).
    const value = Schema.decodeUnknownSync(schema as never)(body) as S["Type"];
    return { ok: true, value };
  } catch (cause) {
    return { ok: false, error: schemaErrorMessage(cause) };
  }
}

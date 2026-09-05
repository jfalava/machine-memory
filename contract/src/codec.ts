import { Schema } from "effect";

import type { JsonValue } from "./json";

/**
 * Encode a domain value to its wire JSON shape.
 * Server-side: fail closed — a SchemaError means we almost shipped garbage.
 */
export function encodeResponse<S extends Schema.ConstraintEncoder<unknown>>(
  schema: S,
  value: S["Type"],
): S["Encoded"] {
  return Schema.encodeSync(schema)(value);
}

/**
 * Decode wire JSON into a domain value.
 * Client-side helper: returns undefined and logs on failure (graceful).
 */
export function decodeResponse<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  body: JsonValue,
  label: string,
): S["Type"] | undefined {
  try {
    return Schema.decodeUnknownSync(schema)(body);
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
export function decodeRequest<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  body: JsonValue,
): DecodeResult<S["Type"]> {
  try {
    const value = Schema.decodeUnknownSync(schema)(body);
    return { ok: true, value };
  } catch (cause) {
    return { ok: false, error: schemaErrorMessage(cause) };
  }
}

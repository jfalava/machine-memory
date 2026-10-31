import { Schema } from "effect";

export type JsonValue = Schema.Json;
// Not `Schema.JsonObject`: that name also binds a schema class instance, so
// type-aware no-misused-spread flags every spread of it.
export type JsonObject = { readonly [key: string]: JsonValue };

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

export function isJsonArray(
  value: JsonValue | undefined,
): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function jsonObject(
  value: JsonValue | undefined,
): JsonObject | undefined {
  try {
    return Schema.decodeUnknownSync(JsonObjectSchema)(value);
  } catch {
    return undefined;
  }
}

export function jsonString(value: JsonValue | undefined): string | undefined {
  try {
    return Schema.decodeUnknownSync(Schema.String)(value);
  } catch {
    return undefined;
  }
}

export function jsonNumber(value: JsonValue | undefined): number | undefined {
  try {
    return Schema.decodeUnknownSync(Schema.Finite)(value);
  } catch {
    return undefined;
  }
}

import { Schema } from "effect";

export type JsonValue = Schema.Json;
export type JsonObject = Schema.JsonObject;

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
    const parsed = Schema.decodeUnknownSync(Schema.Number)(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

import { Schema } from "effect";

export type JsonValue =
  | null
  | number
  | boolean
  | string
  | readonly JsonValue[]
  | JsonObject
  | undefined;
export type JsonObject = { [key: string]: JsonValue };

export function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);

export function parseJson(text: string): JsonValue {
  return Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(text));
}

export function jsonObject(
  value: JsonValue | undefined,
): JsonObject | undefined {
  try {
    return { ...Schema.decodeUnknownSync(JsonObjectSchema)(value) };
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

export function jsonBoolean(value: JsonValue | undefined): boolean | undefined {
  try {
    return Schema.decodeUnknownSync(Schema.Boolean)(value);
  } catch {
    return undefined;
  }
}

export function jsonStringArray(
  value: JsonValue | undefined,
): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings: string[] = [];
  for (const item of value) {
    const parsed = jsonString(item);
    if (parsed === undefined) {
      return undefined;
    }
    strings.push(parsed);
  }
  return strings;
}

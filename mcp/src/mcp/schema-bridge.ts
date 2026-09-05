import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { Schema } from "effect";

/** Effect converters share one Standard Schema object with validation and JSON Schema. */
export function mcpInputSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
): StandardSchemaWithJSON<S["Encoded"], S["Type"]> {
  return Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));
}

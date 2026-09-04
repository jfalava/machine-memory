import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { Schema } from "effect";

/**
 * Bridge Effect Schema tool inputs into MCP's StandardSchemaWithJSON contract.
 * Effect exposes validate and JSON Schema via separate converters; MCP needs both
 * on the same `~standard` object.
 */
export function mcpInputSchema<A>(
  schema: Schema.Top & { readonly Type: A },
): StandardSchemaWithJSON<A, A> {
  const standard = Schema.toStandardSchemaV1(
    // SAFETY: tool input structs are pure sync decoders with no services.
    schema as Schema.Top & { readonly DecodingServices: never },
  );
  // SAFETY: tool input structs are pure data schemas that satisfy Constraint for JSON Schema export.
  const json = Schema.toStandardJSONSchemaV1(
    schema as Schema.Top & Schema.Constraint,
  );
  // SAFETY: MCP needs validate + jsonSchema on one ~standard object; both halves come from the same schema.
  return {
    "~standard": {
      version: 1,
      vendor: "effect",
      validate: standard["~standard"].validate,
      jsonSchema: json["~standard"].jsonSchema,
    },
  } as StandardSchemaWithJSON<A, A>;
}

export function describedString(description: string) {
  return Schema.NonEmptyString.annotate({ description });
}

export function optionalString(description: string) {
  return Schema.optionalKey(Schema.String.annotate({ description }));
}

export function optionalEnum<const L extends ReadonlyArray<string>>(
  literals: L,
  description: string,
) {
  return Schema.optionalKey(
    Schema.Literals(literals).annotate({ description }),
  );
}

export function positiveInt(description: string) {
  return Schema.Int.check(Schema.isGreaterThan(0)).annotate({ description });
}

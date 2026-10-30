import { Schema } from "effect";

// Every CLI payload object keeps keys the tests do not name, so `toEqual`
// still compares the complete printed object after decoding.
const unnamedKeys = [Schema.Record(Schema.String, Schema.Json)] as const;

const SizeReportSchema = Schema.StructWithRest(
  Schema.Struct({
    within_budget: Schema.optionalKey(Schema.Boolean),
    binding_limit: Schema.optionalKey(Schema.NullOr(Schema.String)),
    trimmed_suggestion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  unnamedKeys,
);

const LimitCheckSchema = Schema.StructWithRest(
  Schema.Struct({ pass: Schema.Boolean }),
  unnamedKeys,
);

const TokenReportSchema = Schema.StructWithRest(
  Schema.Struct({
    parts: Schema.optionalKey(
      Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({ part: Schema.String, tokens: Schema.Int }),
          unnamedKeys,
        ),
      ),
    ),
  }),
  unnamedKeys,
);

/** One memory, snapshot, target, or summary row printed by the CLI. */
export const CliRowSchema = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Int),
    content: Schema.optionalKey(Schema.String),
    content_head: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    revision_id: Schema.optionalKey(Schema.Int),
    size: Schema.optionalKey(SizeReportSchema),
  }),
  unnamedKeys,
);
export type CliRow = typeof CliRowSchema.Type;

/** A JSON object printed by one CLI command; fields the tests inspect are typed. */
export const CliOutputSchema = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Int),
    error: Schema.optionalKey(Schema.String),
    note: Schema.optionalKey(Schema.String),
    current_update_count: Schema.optionalKey(Schema.NullOr(Schema.Int)),
    results: Schema.optionalKey(Schema.Array(CliRowSchema)),
    targets: Schema.optionalKey(Schema.Array(CliRowSchema)),
    recent: Schema.optionalKey(Schema.Array(CliRowSchema)),
    classification: Schema.optionalKey(Schema.Array(CliRowSchema)),
    would_match: Schema.optionalKey(CliRowSchema),
    upsert_match: Schema.optionalKey(CliRowSchema),
    findings: Schema.optionalKey(Schema.JsonObject),
    commands: Schema.optionalKey(Schema.JsonObject),
    output_fields: Schema.optionalKey(Schema.JsonObject),
    tokens: Schema.optionalKey(TokenReportSchema),
    size: Schema.optionalKey(SizeReportSchema),
    limits: Schema.optionalKey(
      Schema.StructWithRest(
        Schema.Struct({
          tokens: Schema.optionalKey(LimitCheckSchema),
          bytes_estimate: Schema.optionalKey(LimitCheckSchema),
        }),
        unnamedKeys,
      ),
    ),
  }),
  unnamedKeys,
);
export type CliOutput = typeof CliOutputSchema.Type;

/** Decode stdout of a CLI command that prints one JSON object. */
export const decodeCliOutput = Schema.decodeSync(
  Schema.fromJsonString(CliOutputSchema),
);

/** Decode stdout of a CLI command that prints a JSON array of rows. */
export const decodeCliRows = Schema.decodeSync(
  Schema.fromJsonString(Schema.Array(CliRowSchema)),
);

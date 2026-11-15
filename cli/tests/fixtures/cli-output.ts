import { Schema } from "effect";

// Every CLI payload object keeps keys the tests do not name, so `toEqual`
// still compares the complete printed object after decoding.
const unnamedKeys = [Schema.Record(Schema.String, Schema.Json)] as const;

const SizeReportSchema = Schema.StructWithRest(
  Schema.Struct({
    within_budget: Schema.optionalKey(Schema.Boolean),
    over_by_bytes: Schema.optionalKey(Schema.Int),
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
    repository: Schema.optionalKey(Schema.String),
    warning: Schema.optionalKey(Schema.String),
    current_update_count: Schema.optionalKey(Schema.NullOr(Schema.Int)),
    results: Schema.optionalKey(Schema.Array(CliRowSchema)),
    targets: Schema.optionalKey(Schema.Array(CliRowSchema)),
    recent: Schema.optionalKey(Schema.Array(CliRowSchema)),
    classification: Schema.optionalKey(Schema.Array(CliRowSchema)),
    would_match: Schema.optionalKey(CliRowSchema),
    upsert_match: Schema.optionalKey(CliRowSchema),
    related: Schema.optionalKey(Schema.Array(CliRowSchema)),
    candidates: Schema.optionalKey(Schema.Array(CliRowSchema)),
    findings: Schema.optionalKey(Schema.JsonObject),
    commands: Schema.optionalKey(Schema.JsonObject),
    output_fields: Schema.optionalKey(Schema.JsonObject),
    size: Schema.optionalKey(SizeReportSchema),
  }),
  unnamedKeys,
);
export type CliOutput = typeof CliOutputSchema.Type;

/** Decode stdout of a CLI command that prints one JSON object. */
export const decodeCliOutput = Schema.decodeSync(
  Schema.fromJsonString(CliOutputSchema),
);

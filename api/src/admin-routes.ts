import {
  decodeRequest,
  encodeResponse,
  MigrationLinksRequestSchema,
  MigrationLinksSuccessSchema,
  MigrationRequestInputSchema,
  MigrationSuccessSchema,
  normalizeMigrationRequest,
  QueryRequestSchema,
  QuerySuccessSchema,
  type JsonObject,
  type JsonValue,
  type MigrationItem,
} from "@machine-memory/contract";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { fetchProductRow, type ApiContext } from "./api-context";
import { badRequest } from "./http-failure";

/** POST /query */
export const handleQuery = (ctx: ApiContext, body: JsonValue) =>
  Effect.gen(function* () {
    const input = decodeRequest(QueryRequestSchema, body);
    if (!input.ok) {
      return yield* badRequest(input.error);
    }
    const request = input.value;

    if (request.operation === "run") {
      const response = yield* ctx.d1
        .prepare(request.sql)
        .bind(...request.params)
        .run();
      return yield* HttpServerResponse.json(
        encodeResponse(QuerySuccessSchema, {
          ok: true,
          result: {
            changes: response.meta.changes,
            lastInsertRowid: response.meta.last_row_id,
          },
        }),
      );
    }

    const rows = yield* ctx.sql.unsafe<JsonObject>(request.sql, request.params);
    const result = request.operation === "all" ? rows : (rows[0] ?? null);
    return yield* HttpServerResponse.json(
      encodeResponse(QuerySuccessSchema, { ok: true, result }),
    );
  });

/** POST /migrate */
export const handleMigration = (ctx: ApiContext, body: JsonValue) =>
  Effect.gen(function* () {
    const input = decodeRequest(MigrationRequestInputSchema, body);
    if (!input.ok) {
      return yield* badRequest(input.error);
    }
    const normalized = normalizeMigrationRequest(input.value);
    if (!normalized.ok) {
      return yield* badRequest(normalized.error);
    }
    const request = normalized.value;
    const { d1 } = ctx;
    // One D1 transaction: source identity, not content similarity, provides
    // retry safety for every status and preserves distinct metadata.
    const statements = request.rows.flatMap((row) => [
      d1
        .prepare(`INSERT INTO memories (repository, content, tags, context, memory_type, status,
            superseded_by, source_agent, last_updated_by, update_count, certainty, refs,
            expires_after_days, evidence, validation_gaps, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, datetime('now')), coalesce(?, datetime('now'))
            WHERE NOT EXISTS (SELECT 1 FROM memory_migration_sources WHERE repository = ? AND source = ? AND source_id = ?)
            RETURNING id`)
        .bind(
          request.repository,
          row.content,
          row.tags,
          row.context,
          row.memory_type,
          row.status,
          row.source_agent,
          row.last_updated_by,
          row.update_count,
          row.certainty,
          row.refs,
          row.expires_after_days,
          JSON.stringify(row.evidence),
          JSON.stringify(row.validation_gaps),
          row.created_at,
          row.updated_at,
          request.repository,
          request.source,
          row.source_id,
        ),
      d1
        .prepare(`INSERT INTO memory_migration_sources (repository, source, source_id, target_id)
            SELECT ?, ?, ?, last_insert_rowid() WHERE NOT EXISTS
            (SELECT 1 FROM memory_migration_sources WHERE repository = ? AND source = ? AND source_id = ?)`)
        .bind(
          request.repository,
          request.source,
          row.source_id,
          request.repository,
          request.source,
          row.source_id,
        ),
      d1
        .prepare(
          `SELECT target_id AS id FROM memory_migration_sources WHERE repository = ? AND source = ? AND source_id = ?`,
        )
        .bind(request.repository, request.source, row.source_id),
    ]);
    const results =
      statements.length === 0
        ? []
        : yield* d1.batch<{ id: number }>(statements);
    const items = request.rows.map((row, i): MigrationItem => ({
      source_id: row.source_id,
      target_id: results[i * 3 + 2].results[0].id,
      status: results[i * 3].results.length > 0 ? "inserted" : "duplicate",
    }));
    const inserted = items.filter((item) => item.status === "inserted").length;
    return yield* HttpServerResponse.json(
      encodeResponse(MigrationSuccessSchema, {
        ok: true,
        result: {
          processed: request.rows.length,
          inserted,
          duplicates: items.length - inserted,
          items,
        },
      }),
    );
  });

/** POST /migrate/links */
export const handleMigrationLinks = (ctx: ApiContext, body: JsonValue) =>
  Effect.gen(function* () {
    const input = decodeRequest(MigrationLinksRequestSchema, body);
    if (!input.ok) {
      return yield* badRequest(input.error);
    }
    const { repository, links } = input.value;
    for (const link of links) {
      if (
        link.target_id === link.superseded_by_target_id ||
        !(yield* fetchProductRow(ctx, repository, link.target_id)) ||
        !(yield* fetchProductRow(ctx, repository, link.superseded_by_target_id))
      ) {
        return yield* badRequest(
          "Migration links require distinct memories in the same repository.",
        );
      }
    }
    const statements = links.map((link) =>
      ctx.d1
        .prepare(`UPDATE memories
          SET superseded_by = ?, update_count = update_count + 1
          WHERE repository = ? AND id = ? RETURNING id`)
        .bind(link.superseded_by_target_id, repository, link.target_id),
    );
    const results =
      statements.length === 0 ? [] : yield* ctx.d1.batch(statements);
    const updated = results.reduce(
      (count, result) => count + result.results.length,
      0,
    );

    return yield* HttpServerResponse.json(
      encodeResponse(MigrationLinksSuccessSchema, {
        ok: true,
        result: { updated },
      }),
    );
  });

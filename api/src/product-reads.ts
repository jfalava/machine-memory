import {
  analyzeMemoryDoctor,
  compareMemoryFact,
  droppedDetails,
  embeddingSizeReport,
  jsonNumber,
  jsonString,
  normalizeListRepositoriesArgs,
  normalizeMemoryHistoryArgs,
  normalizeMemoryListArgs,
  normalizeMemorySizeArgs,
  type JsonObject,
} from "@machine-memory/contract";
import * as Effect from "effect/Effect";

import {
  fetchProductRow,
  type ApiContext,
  type ProductHandlers,
} from "./api-context";
import { memoryNotFound } from "./http-failure";
import {
  historyCountSelect,
  historySelect,
  listCountSelect,
  listSelect,
  REPOSITORY_COUNT_SQL,
  repositoryStatsSelect,
} from "./product-api";
import {
  embeddingTextForMemory,
  summarizeMemoryStats,
  toHistoryRow,
  toProductRow,
} from "./product-logic";

type ReadRoute =
  | "list-repositories"
  | "get"
  | "history"
  | "list"
  | "doctor"
  | "stats"
  | "gc"
  | "size"
  | "verify"
  | "diff";

/** Product routes that only read memories. */
export const productReadHandlers = (
  ctx: ApiContext,
): Pick<ProductHandlers, ReadRoute> => ({
  "list-repositories": (input) =>
    Effect.gen(function* () {
      const args = normalizeListRepositoriesArgs(input);
      const query = repositoryStatsSelect(args.limit, args.offset);
      const rows = yield* ctx.sql.unsafe<JsonObject>(query.sql, query.params);
      const countRows = yield* ctx.sql.unsafe<JsonObject>(REPOSITORY_COUNT_SQL);
      const totalCount = jsonNumber(countRows[0]?.total_count) ?? 0;
      const repositories = rows.flatMap((row) => {
        const slug = jsonString(row.repository);
        if (!slug) {
          return [];
        }
        return [
          {
            slug,
            total: jsonNumber(row.total) ?? 0,
            active: jsonNumber(row.active) ?? 0,
            deprecated: jsonNumber(row.deprecated) ?? 0,
            superseded: jsonNumber(row.superseded) ?? 0,
          },
        ];
      });
      return {
        repositories,
        count: repositories.length,
        total_count: totalCount,
        offset: args.offset,
        limit: args.limit,
        has_more: args.offset + repositories.length < totalCount,
      };
    }),

  get: (input) =>
    Effect.gen(function* () {
      const row = yield* fetchProductRow(ctx, input.repository, input.id);
      if (!row) {
        return yield* memoryNotFound(input.id, input.repository);
      }
      return row;
    }),

  history: (input) =>
    Effect.gen(function* () {
      const args = normalizeMemoryHistoryArgs(input);
      const query = historySelect(
        args.repository,
        args.id,
        args.limit,
        args.offset,
      );
      const rows = yield* ctx.sql.unsafe<JsonObject>(query.sql, query.params);
      const countQuery = historyCountSelect(args.repository, args.id);
      const countRows = yield* ctx.sql.unsafe<JsonObject>(
        countQuery.sql,
        countQuery.params,
      );
      const current = yield* fetchProductRow(ctx, args.repository, args.id);
      const totalCount = jsonNumber(countRows[0]?.total_count) ?? 0;
      const results = rows.map(toHistoryRow);
      return {
        repository: args.repository,
        id: args.id,
        current_update_count: current?.update_count ?? null,
        count: results.length,
        total_count: totalCount,
        offset: args.offset,
        limit: args.limit,
        has_more: args.offset + results.length < totalCount,
        results,
      };
    }),

  list: (input) =>
    Effect.gen(function* () {
      const args = normalizeMemoryListArgs(input);
      const query = listSelect(args.repository, args, args.limit, args.offset);
      const rows = yield* ctx.sql.unsafe<JsonObject>(query.sql, query.params);
      const countQuery = listCountSelect(args.repository, args);
      const countRows = yield* ctx.sql.unsafe<JsonObject>(
        countQuery.sql,
        countQuery.params,
      );
      const totalCount = jsonNumber(countRows[0]?.total_count) ?? 0;
      const results = rows.map(toProductRow);
      return {
        count: results.length,
        total_count: totalCount,
        offset: args.offset,
        limit: args.limit,
        has_more: args.offset + results.length < totalCount,
        results,
      };
    }),

  doctor: (input) =>
    Effect.gen(function* () {
      const rows = yield* ctx.sql.unsafe<JsonObject>(
        `SELECT * FROM memories WHERE repository = ? AND status = 'active' ORDER BY updated_at DESC, id DESC`,
        [input.repository],
      );
      return analyzeMemoryDoctor(input.repository, rows);
    }),

  stats: (input) =>
    Effect.gen(function* () {
      const rows = yield* ctx.sql.unsafe<JsonObject>(
        "SELECT * FROM memories WHERE repository = ?",
        [input.repository],
      );
      return summarizeMemoryStats(input.repository, rows);
    }),

  gc: (input) =>
    Effect.gen(function* () {
      const rows = yield* ctx.sql.unsafe<JsonObject>(
        `SELECT * FROM memories
           WHERE repository = ?
             AND status = 'active'
             AND expires_after_days IS NOT NULL
             AND datetime(updated_at, '+' || expires_after_days || ' days') <= datetime('now')
           ORDER BY updated_at ASC`,
        [input.repository],
      );
      const expired = rows.map(toProductRow);
      return {
        repository: input.repository,
        dry_run: true as const,
        count: expired.length,
        ids: expired.map((row) => row.id),
        expired,
      };
    }),

  size: (input) =>
    Effect.sync(() => {
      const args = normalizeMemorySizeArgs(input);
      const size = embeddingSizeReport(
        embeddingTextForMemory({
          content: args.content,
          tags: args.tags ?? "",
          context: args.context ?? "",
          memory_type: args.memory_type,
          status: args.status,
          certainty: args.certainty,
        }),
      );
      return { size };
    }),

  verify: (input) =>
    Effect.gen(function* () {
      const row = yield* fetchProductRow(ctx, input.repository, input.id);
      if (!row) {
        return yield* memoryNotFound(input.id, input.repository);
      }
      const result = compareMemoryFact(row.content, input.fact);
      return result.conflict
        ? {
            id: input.id,
            ok: false as const,
            result: "conflict" as const,
            similarity: result.similarity,
            warning: "Conflict",
          }
        : {
            id: input.id,
            ok: true as const,
            result: "consistent" as const,
            similarity: result.similarity,
          };
    }),

  diff: (input) =>
    Effect.gen(function* () {
      const row = yield* fetchProductRow(ctx, input.repository, input.id);
      if (!row) {
        return yield* memoryNotFound(input.id, input.repository);
      }
      const result = compareMemoryFact(row.content, input.content);
      return {
        id: input.id,
        conflict: result.conflict,
        similarity: result.similarity,
        added_terms: result.added_terms,
        removed_terms: result.removed_terms,
        dropped: droppedDetails(row.content, input.content),
      };
    }),
});

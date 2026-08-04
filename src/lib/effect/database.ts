import { Database, type SQLQueryBindings } from "bun:sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { ensureDb, allWithRetry, getWithRetry, runWithRetry } from "../db";
import type { DbAccessMode } from "../db";

export class MemoryDatabaseError extends Schema.TaggedErrorClass<MemoryDatabaseError>()(
  "MemoryDatabaseError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export type MemoryDatabaseApi = {
  readonly database: Database;
  readonly run: (
    sql: string,
    params?: SQLQueryBindings[],
  ) => Effect.Effect<unknown, MemoryDatabaseError>;
  readonly get: (
    sql: string,
    params?: SQLQueryBindings[],
  ) => Effect.Effect<unknown, MemoryDatabaseError>;
  readonly all: (
    sql: string,
    params?: SQLQueryBindings[],
  ) => Effect.Effect<unknown[], MemoryDatabaseError>;
};

export class MemoryDatabase extends Context.Service<
  MemoryDatabase,
  MemoryDatabaseApi
>()("machine-memory/MemoryDatabase") {}

function operationError(
  operation: string,
  cause: unknown,
): MemoryDatabaseError {
  return new MemoryDatabaseError({
    operation,
    message:
      cause instanceof Error ? cause.message : "Database operation failed.",
    cause,
  });
}

function effectful<T>(
  operation: string,
  run: () => T,
): Effect.Effect<T, MemoryDatabaseError> {
  return Effect.try({
    try: run,
    catch: (cause) => operationError(operation, cause),
  });
}

export const layer = (
  mode: DbAccessMode,
): Layer.Layer<MemoryDatabase, MemoryDatabaseError> =>
  Layer.effect(
    MemoryDatabase,
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(
        effectful("open", () => ensureDb(mode)),
        (instance) => Effect.sync(() => instance.close()),
      );

      return MemoryDatabase.of({
        database,
        run: (sql, params = []) =>
          effectful("run", () => runWithRetry(database, sql, params)),
        get: (sql, params = []) =>
          effectful("get", () => getWithRetry(database, sql, params)),
        all: (sql, params = []) =>
          effectful(
            "all",
            () => allWithRetry(database, sql, params) as unknown[],
          ),
      });
    }),
  );

import { Context, Effect, Layer } from "effect";
import {
  allWithRetry,
  ensureDb,
  getWithRetry,
  runWithRetry,
  type DbAccessMode,
  type SqlQueryBinding,
} from "../db";
import { databaseConfig } from "../database-config";
import { MemoryDatabaseError } from "./errors";
import { remoteLayer } from "./remote-database";

export { MemoryDatabaseError } from "./errors";

export type MemoryDatabaseApi = {
  readonly run: (
    sql: string,
    params?: SqlQueryBinding[],
  ) => Effect.Effect<unknown, MemoryDatabaseError>;
  readonly get: (
    sql: string,
    params?: SqlQueryBinding[],
  ) => Effect.Effect<unknown, MemoryDatabaseError>;
  readonly all: (
    sql: string,
    params?: SqlQueryBinding[],
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
): Layer.Layer<MemoryDatabase, MemoryDatabaseError> => {
  const config = databaseConfig();
  if (config.kind === "remote") {
    return remoteLayer(config.url, config.token);
  }

  return Layer.effect(
    MemoryDatabase,
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(
        effectful("open", () => ensureDb(mode)),
        (instance) => Effect.sync(() => instance.close()),
      );

      return MemoryDatabase.of({
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
};

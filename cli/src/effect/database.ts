import { Context, Effect, Layer } from "effect";
import {
  allWithRetry,
  ensureDb,
  getWithRetry,
  runWithRetry,
  type DbAccessMode,
  type SqlQueryBinding,
} from "../db";
import {
  loadDatabaseConfig,
  validateDatabaseBackendFlags,
  type DatabaseBackendFlags,
} from "../database-config";
import { MemoryDatabaseError } from "./errors";
import { remoteLayer } from "./remote-database";
import type { MemoryVectorApi } from "./vectorize";

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
  readonly vectorize?: MemoryVectorApi;
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

function localLayer(
  mode: DbAccessMode,
): Layer.Layer<MemoryDatabase, MemoryDatabaseError> {
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
}

export const layer = (
  mode: DbAccessMode,
  backendFlags?: DatabaseBackendFlags,
): Layer.Layer<MemoryDatabase, MemoryDatabaseError> =>
  Layer.unwrap(
    Effect.tryPromise({
      try: () => {
        validateDatabaseBackendFlags(
          backendFlags ?? { local: false, remote: false },
          true,
        );
        return loadDatabaseConfig(process.env, backendFlags);
      },
      catch: (cause) =>
        new MemoryDatabaseError({
          operation: "config",
          message:
            cause instanceof Error
              ? cause.message
              : "Could not load database credentials.",
          cause,
        }),
    }).pipe(
      Effect.map((config) =>
        config.kind === "remote"
          ? remoteLayer(config.url, config.token)
          : localLayer(mode),
      ),
    ),
  );

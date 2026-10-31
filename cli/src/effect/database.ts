import { Context, Effect, Layer } from "effect";

import {
  loadDatabaseConfig,
  validateDatabaseBackendFlags,
  type DatabaseBackendFlags,
} from "../database-config";
import type { DbAccessMode, SqlQueryBinding } from "../db";
import type { JsonValue } from "../json";
import { databaseOperationError, MemoryDatabaseError } from "./errors";
import { remoteLayer } from "./remote-database";
import type { MemoryVectorApi } from "./vectorize";

export { MemoryDatabaseError } from "./errors";

export type MemoryDatabaseApi = {
  readonly run: (
    sql: string,
    params?: SqlQueryBinding[],
  ) => Effect.Effect<JsonValue, MemoryDatabaseError>;
  readonly get: (
    sql: string,
    params?: SqlQueryBinding[],
  ) => Effect.Effect<JsonValue | undefined, MemoryDatabaseError>;
  readonly all: (
    sql: string,
    params?: SqlQueryBinding[],
  ) => Effect.Effect<JsonValue[], MemoryDatabaseError>;
  readonly vectorize?: MemoryVectorApi;
};

export class MemoryDatabase extends Context.Service<
  MemoryDatabase,
  MemoryDatabaseApi
>()("machine-memory/MemoryDatabase") {}

function loadLocalLayer(
  mode: DbAccessMode,
): Effect.Effect<
  Layer.Layer<MemoryDatabase, MemoryDatabaseError>,
  MemoryDatabaseError
> {
  return Effect.tryPromise({
    try: async () => (await import("./local-database")).localLayer(mode),
    catch: (cause) => databaseOperationError("load", cause),
  });
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
      Effect.flatMap((config) =>
        config.kind === "remote"
          ? Effect.succeed(remoteLayer(config.url, config.token))
          : loadLocalLayer(mode),
      ),
    ),
  );

import { databaseFailureGuidance } from "@machine-memory/contract";
import { Context, Effect, Layer } from "effect";
import type { DbAccessMode, SqlQueryBinding } from "../db";
import {
  loadDatabaseConfig,
  validateDatabaseBackendFlags,
  type DatabaseBackendFlags,
} from "../database-config";
import { MemoryDatabaseError } from "./errors";
import { remoteLayer } from "./remote-database";
import type { MemoryVectorApi } from "./vectorize";
import type { JsonValue } from "../json";

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

function operationError(
  operation: string,
  cause: unknown,
): MemoryDatabaseError {
  const guidance = databaseFailureGuidance(cause);
  return new MemoryDatabaseError({
    operation,
    message:
      guidance?.error ??
      (cause instanceof Error ? cause.message : "Database operation failed."),
    cause,
  });
}

function loadLocalLayer(
  mode: DbAccessMode,
): Effect.Effect<
  Layer.Layer<MemoryDatabase, MemoryDatabaseError>,
  MemoryDatabaseError
> {
  return Effect.tryPromise({
    try: async () => (await import("./local-database")).localLayer(mode),
    catch: (cause) => operationError("load", cause),
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

import { databaseFailureGuidance } from "@machine-memory/contract";
import { Effect, Layer, Schema } from "effect";
import {
  allWithRetry,
  ensureDb,
  getWithRetry,
  runWithRetry,
  type DbAccessMode,
} from "../db";
import { MemoryDatabase } from "./database";
import { MemoryDatabaseError } from "./errors";

function effectful<T>(
  operation: string,
  run: () => T,
): Effect.Effect<T, MemoryDatabaseError> {
  return Effect.try({
    try: run,
    catch: (cause) => {
      const guidance = databaseFailureGuidance(cause);
      return new MemoryDatabaseError({
        operation,
        message:
          guidance?.error ??
          (cause instanceof Error
            ? cause.message
            : "Database operation failed."),
        cause,
      });
    },
  });
}

export function localLayer(
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
          effectful("run", () =>
            Schema.decodeUnknownSync(Schema.MutableJson)(
              runWithRetry(database, sql, params),
            ),
          ),
        get: (sql, params = []) =>
          effectful("get", () => {
            const result = getWithRetry(database, sql, params);
            return result === undefined
              ? undefined
              : Schema.decodeUnknownSync(Schema.MutableJson)(result);
          }),
        all: (sql, params = []) =>
          effectful("all", () => [
            ...Schema.decodeUnknownSync(Schema.Array(Schema.MutableJson))(
              allWithRetry(database, sql, params),
            ),
          ]),
      });
    }),
  );
}

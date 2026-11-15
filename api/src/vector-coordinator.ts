import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Layer } from "effect";
import * as Clock from "effect/Clock";

import { Database } from "../../iac/src/database";
import { VectorIndex } from "../../iac/src/vectorize";
import {
  aiEmbedding,
  drainVectorSync,
  DRAIN_INTERVAL_MS,
  wakeAlarmAt,
} from "./vector-sync";

// One coordinator for the index, not one for every HTTP request. Only alarm()
// submits mutations; wake/cron cannot run competing drains across awaits. The
// alarm is set only while index writes are queued: an idle coordinator sleeps
// until a request or the hourly cron wakes it. Drains that do work are at
// least DRAIN_INTERVAL_MS apart.
export class VectorCoordinator extends Cloudflare.DurableObject<VectorCoordinator>()(
  "VectorCoordinator",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const db = yield* Cloudflare.D1.QueryDatabase(Database);
    const indexResource = yield* VectorIndex;
    const index = yield* Cloudflare.Vectorize.SearchIndex(indexResource);
    const ai = yield* Cloudflare.Workers.AI();
    // alchemy runs this outer effect at init and the returned one per instance.
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.sync(() => {
      // Set by a request that arrives while a drain is running.
      let wokenDuringDrain = false;
      const wake = () =>
        Effect.gen(function* () {
          wokenDuringDrain = true;
          const next = wakeAlarmAt(
            yield* state.storage.getAlarm(),
            yield* Clock.currentTimeMillis,
          );
          if (next !== undefined) {
            yield* state.storage.setAlarm(next);
          }
        });
      return {
        wake,
        alarm: () =>
          Effect.gen(function* () {
            // Schedule continuation before external I/O, including crashes and long outages.
            const now = yield* Clock.currentTimeMillis;
            const fallback = now + DRAIN_INTERVAL_MS;
            yield* state.storage.setAlarm(fallback);
            wokenDuringDrain = false;
            const [rawDb, rawIndex, rawAi] = yield* Effect.all([
              db.raw,
              index.raw,
              ai.raw,
            ]);
            const next = yield* Effect.promise(() =>
              drainVectorSync(
                {
                  db: rawDb,
                  index: rawIndex,
                  embed: (text) => aiEmbedding(rawAi, text),
                },
                now,
              ),
            ).pipe(
              // A drain that failed as a whole is retried at the fallback.
              Effect.catchCause((cause) =>
                Effect.logError(cause).pipe(Effect.as(fallback)),
              ),
            );
            // A write that landed during the drain may have missed it; look again at the fallback.
            if (wokenDuringDrain) {
              return;
            }
            if (next === undefined) {
              yield* state.storage.deleteAlarm();
            } else if (next > fallback) {
              yield* state.storage.setAlarm(next);
            }
          }),
      };
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Vectorize.SearchIndexBinding,
        Cloudflare.Workers.AIBinding,
      ),
    ),
  ),
) {}

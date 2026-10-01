import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import * as Clock from "effect/Clock";

import { Database } from "../../iac/src/database";
import { VectorIndex } from "../../iac/src/vectorize";
import { aiEmbedding, drainVectorSync } from "./vector-sync";

// One coordinator for the index, not one for every HTTP request. Only alarm()
// submits mutations; wake/cron cannot run competing drains across awaits.
export class VectorCoordinator extends Cloudflare.DurableObject<VectorCoordinator>()(
  "VectorCoordinator",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const db = yield* Cloudflare.D1.QueryDatabase(Database);
    const indexResource = yield* VectorIndex;
    const index = yield* Cloudflare.Vectorize.SearchIndex(indexResource);
    const ai = yield* Cloudflare.Workers.AI();
    return Effect.sync(() => {
      const wake = () =>
        Effect.gen(function* () {
          const alarm = yield* state.storage.getAlarm();
          const next = (yield* Clock.currentTimeMillis) + 1000;
          if (alarm === null || alarm > next) {
            yield* state.storage.setAlarm(next);
          }
        });
      return {
        wake,
        alarm: () =>
          Effect.gen(function* () {
            // Schedule continuation before external I/O, including crashes and long outages.
            yield* state.storage.setAlarm(
              (yield* Clock.currentTimeMillis) + 60_000,
            );
            const [rawDb, rawIndex, rawAi] = yield* Effect.all([
              db.raw,
              index.raw,
              ai.raw,
            ]);
            yield* Effect.promise(() =>
              drainVectorSync({
                db: rawDb,
                index: rawIndex,
                embed: (text) => aiEmbedding(rawAi, text),
              }),
            ).pipe(Effect.catchCause((cause) => Effect.logError(cause)));
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

import { Cause, Effect, Option } from "effect";
import pc from "picocolors";
import { printJson, usageError } from "../../cli-utils";
import { MemoryDatabaseError } from "../../effect/errors";
import { upsertMemoryVector } from "../../effect/vector-sync";
import { vectorizeRateLimitInfo } from "../../effect/vectorize";
import {
  jsonNumber,
  jsonString,
  type JsonObject,
  type JsonValue,
} from "../../json";
import { normalizeSqliteRow } from "../shared";
import { repositoryForCurrentDirectory } from "../../repository";
import { requireDatabase, type CommandContext } from "../runtime/context";

const REINDEX_REQUEST_INTERVAL_MS = 250;
const REINDEX_MAX_RATE_LIMIT_RETRIES = 3;
const REINDEX_RETRY_BASE_DELAY_MS = 1000;
const REINDEX_MAX_RETRY_DELAY_MS = 60_000;

const PROGRESS_FRAMES = [
  "·  ",
  "·· ",
  "···",
  " ··",
  "  ·",
  " ··",
  "···",
  "·· ",
];

type ReindexFailure = {
  id: JsonValue;
  error: string;
  rateLimited: boolean;
};

type ReindexProgress = {
  update: (completed: number) => void;
  stop: () => void;
};

type ReindexAttempt =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: MemoryDatabaseError;
      readonly rateLimited: boolean;
      readonly retryAfterMs?: number;
    };

function createReindexThrottle() {
  let nextRequestAt = 0;
  return () =>
    Effect.gen(function* () {
      const delay = Math.max(0, nextRequestAt - Date.now());
      if (delay > 0) {
        yield* Effect.sleep(delay);
      }
      nextRequestAt = Date.now() + REINDEX_REQUEST_INTERVAL_MS;
    });
}

function retryDelayMs(retryNumber: number, retryAfterMs: number | undefined) {
  const exponentialDelay = Math.min(
    REINDEX_MAX_RETRY_DELAY_MS,
    REINDEX_RETRY_BASE_DELAY_MS * 2 ** (retryNumber - 1),
  );
  return Math.min(
    REINDEX_MAX_RETRY_DELAY_MS,
    Math.max(exponentialDelay, retryAfterMs ?? 0),
  );
}

function reindexError(
  cause: Cause.Cause<MemoryDatabaseError>,
): MemoryDatabaseError {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error) && error.value instanceof MemoryDatabaseError) {
    return error.value;
  }
  return new MemoryDatabaseError({
    operation: "vectorize/upsert",
    message: "Vectorize upsert failed.",
    cause,
  });
}

function upsertMemoryWithRetry(
  database: NonNullable<CommandContext["database"]>,
  row: JsonObject,
  throttle: () => Effect.Effect<void>,
): Effect.Effect<ReindexAttempt> {
  return Effect.gen(function* () {
    let retryNumber = 0;
    while (true) {
      yield* throttle();
      const result = yield* upsertMemoryVector(database, row).pipe(
        Effect.map((): ReindexAttempt => ({ ok: true })),
        Effect.catchCause((cause) => {
          const error = reindexError(cause);
          const rateLimit = vectorizeRateLimitInfo(error);
          return Effect.succeed<ReindexAttempt>({
            ok: false,
            error,
            rateLimited: rateLimit !== undefined,
            retryAfterMs: rateLimit?.retryAfterMs,
          });
        }),
      );
      if (result.ok) {
        return result;
      }

      if (
        !result.rateLimited ||
        retryNumber >= REINDEX_MAX_RATE_LIMIT_RETRIES
      ) {
        return result;
      }

      retryNumber += 1;
      yield* Effect.sleep(retryDelayMs(retryNumber, result.retryAfterMs));
    }
  });
}

function compactFailureError(failure: ReindexFailure): string {
  if (failure.rateLimited) {
    return "Too Many Requests";
  }
  const message = failure.error.replace(/\s+/g, " ").trim();
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
}

function groupedFailures(failures: ReindexFailure[]) {
  const groups = new Map<string, string[]>();
  for (const failure of failures) {
    const error = compactFailureError(failure);
    const ids = groups.get(error) ?? [];
    ids.push(jsonString(failure.id) ?? String(jsonNumber(failure.id) ?? ""));
    groups.set(error, ids);
  }
  return groups;
}

function printFailureDetails(failures: ReindexFailure[]): void {
  console.info(pc.dim("Failure details"));
  for (const [error, ids] of groupedFailures(failures)) {
    console.info(
      `  ${pc.red("×")} ${pc.bold(`${ids.length} ${ids.length === 1 ? "memory" : "memories"}`)} ${pc.dim("·")} ${error}`,
    );
    console.info(`    ${pc.dim("IDs")}  ${ids.join(", ")}`);
  }
  if (failures.some((failure) => failure.rateLimited)) {
    console.info();
    console.info(
      `${pc.dim("Next")}       Run reindex again to retry the remaining failures.`,
    );
  }
}

function createReindexProgress(
  repository: string,
  total: number,
  enabled: boolean,
): ReindexProgress {
  if (!enabled || !process.stdout.isTTY) {
    return { update: () => undefined, stop: () => undefined };
  }

  let completed = 0;
  let frame = 0;
  const render = () => {
    process.stdout.write(
      `\r\x1b[2K ${pc.cyan(PROGRESS_FRAMES[frame])} Reindexing ${pc.dim(repository)} ${completed}/${total}`,
    );
    frame = (frame + 1) % PROGRESS_FRAMES.length;
  };

  render();
  const timer = setInterval(render, 120);
  return {
    update: (nextCompleted) => {
      completed = nextCompleted;
      render();
    },
    stop: () => {
      clearInterval(timer);
      process.stdout.write("\r\x1b[2K");
    },
  };
}

function printHumanSummary(
  repository: string,
  total: number,
  upserted: number,
  failures: ReindexFailure[],
): void {
  console.info();
  if (total === 0) {
    console.info(pc.green(pc.bold("✓ Reindex complete")));
    console.info(`${pc.dim("Repository")}  ${pc.cyan(repository)}`);
    console.info(`${pc.dim("Memories")}    none found`);
    console.info();
    return;
  }

  if (failures.length === 0) {
    console.info(pc.green(pc.bold("✓ Reindex complete")));
    console.info(`${pc.dim("Repository")}  ${pc.cyan(repository)}`);
    console.info(`${pc.dim("Processed")}   ${upserted}/${total} memories`);
    console.info();
    return;
  }

  console.info(pc.yellow(pc.bold("! Reindex completed with failures")));
  console.info(`${pc.dim("Repository")}  ${pc.cyan(repository)}`);
  console.info(`${pc.dim("Processed")}   ${upserted}/${total} memories`);
  console.info(`${pc.dim("Failed")}      ${failures.length} memories`);
  console.info();
  printFailureDetails(failures);
  console.info();
}

function printHumanStart(repository: string, total: number): void {
  console.info();
  console.info(pc.bold("machine-memory reindex"));
  console.info(`${pc.dim("Repository")}  ${pc.cyan(repository)}`);
  console.info(`${pc.dim("Memories")}    ${total}`);
  console.info();
}

export function handleReindexCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const database = requireDatabase(commandCtx);
    if (!database.vectorize) {
      usageError("Reindex requires the remote backend: reindex --remote.");
    }

    const repository = repositoryForCurrentDirectory();
    const rows = yield* database.all(
      "SELECT * FROM memories WHERE repository = ? ORDER BY id ASC",
      [repository],
    );
    const failures: ReindexFailure[] = [];
    let upserted = 0;
    let completed = 0;
    const throttle = createReindexThrottle();
    const humanOutput =
      !commandCtx.outputMode.jsonMin && !commandCtx.outputMode.quiet;
    if (humanOutput) {
      yield* Effect.sync(() => printHumanStart(repository, rows.length));
    }
    const progress = createReindexProgress(
      repository,
      rows.length,
      humanOutput,
    );

    yield* Effect.gen(function* () {
      for (const row of rows.map((entry) => normalizeSqliteRow(entry))) {
        const result = yield* upsertMemoryWithRetry(database, row, throttle);
        if (result.ok) {
          upserted += 1;
        } else {
          failures.push({
            id: row.id,
            error: result.error.message,
            rateLimited: result.rateLimited,
          });
        }
        completed += 1;
        progress.update(completed);
      }
    }).pipe(Effect.ensuring(Effect.sync(() => progress.stop())));

    yield* Effect.sync(() => {
      if (commandCtx.outputMode.jsonMin) {
        printJson({
          repository,
          total: rows.length,
          upserted,
          failed: failures.length,
          failures: failures.map(({ id, error }) => ({ id, error })),
        });
        return;
      }
      if (humanOutput) {
        printHumanSummary(repository, rows.length, upserted, failures);
      }
    });
    if (failures.length > 0) {
      yield* Effect.fail(
        new MemoryDatabaseError({
          operation: "vectorize/reindex",
          message: `Reindex failed for ${failures.length} memory vector${failures.length === 1 ? "" : "s"}.`,
          cause: failures,
        }),
      );
    }
  });
}

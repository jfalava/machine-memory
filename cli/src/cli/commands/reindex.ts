import { Effect } from "effect";
import pc from "picocolors";
import { printJson, usageError } from "../../cli-utils";
import { MemoryDatabaseError } from "../../effect/errors";
import { upsertMemoryVector } from "../../effect/vector-sync";
import { normalizeSqliteRow } from "../shared";
import { repositoryForCurrentDirectory } from "../../repository";
import { requireDatabase, type CommandContext } from "../runtime/context";

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

type ReindexFailure = { id: unknown; error: string };

type ReindexProgress = {
  update: (completed: number) => void;
  stop: () => void;
};

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
  console.info(
    `${pc.dim("Processed")}   ${upserted}/${total} memories (${failures.length} failed)`,
  );
  for (const failure of failures) {
    console.info(`  ${pc.dim("•")} ${String(failure.id)}: ${failure.error}`);
  }
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
        const result = yield* upsertMemoryVector(database, row).pipe(
          Effect.map(() => ({ ok: true as const })),
          Effect.catchCause((cause) =>
            Effect.succeed({
              ok: false as const,
              error: String(cause),
            }),
          ),
        );
        if (result.ok) {
          upserted += 1;
        } else {
          failures.push({ id: row.id, error: result.error });
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
          failures,
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

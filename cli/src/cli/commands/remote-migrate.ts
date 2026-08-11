import pc from "picocolors";
import { Effect } from "effect";
import { resolve } from "node:path";
import {
  loadDatabaseConfig,
  validateDatabaseBackendFlags,
} from "../../database-config";
import {
  migrateRemoteLinks,
  migrateRemoteRows,
  type RemoteMigrationBatchResult,
} from "../../effect/remote-migration";
import { CommandError } from "../../effect/errors";
import {
  readLocalMigrationRows,
  resolveMigrationSourcePath,
} from "../../remote-migration";
import { repositoryForCurrentDirectory } from "../../repository";
import type { CommandContext } from "../runtime/context";
import { replaceMemoryBlock } from "./agents-md-content";

const ROW_BATCH_SIZE = 50;
const LINK_BATCH_SIZE = 100;

function migrationCommandError(message: string, cause?: unknown): CommandError {
  return new CommandError({
    message,
    command: "local export",
    cause,
  });
}

function positionalSourcePath(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("--"));
}

function chunks<A>(values: A[], size: number): A[][] {
  const result: A[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function emptyBatchResult(): RemoteMigrationBatchResult {
  return { processed: 0, inserted: 0, duplicates: 0, items: [] };
}

function updateAgentsMdForRemote(context: CommandContext) {
  const agentsMdPath = resolve(process.cwd(), "AGENTS.md");
  return Effect.gen(function* () {
    const agentsMdExists = yield* context.fileSystem.exists(agentsMdPath);
    const existingContent = agentsMdExists
      ? new TextDecoder().decode(
          yield* context.fileSystem.readFile(agentsMdPath),
        )
      : "";
    yield* context.fileSystem.writeFile(
      agentsMdPath,
      new TextEncoder().encode(replaceMemoryBlock(existingContent, "remote")),
    );
  }).pipe(
    Effect.mapError((cause) =>
      migrationCommandError("Could not update AGENTS.md for --remote.", cause),
    ),
  );
}

export function handleLocalExport(context: CommandContext) {
  return Effect.gen(function* () {
    const backendFlags = {
      local: context.args.includes("--local"),
      remote: context.args.includes("--remote"),
    };
    yield* Effect.try({
      try: () => {
        validateDatabaseBackendFlags(backendFlags, true);
        if (!backendFlags.remote) {
          throw new Error(
            "Local export requires --remote; --local is not supported.",
          );
        }
      },
      catch: (cause) =>
        migrationCommandError(
          cause instanceof Error
            ? cause.message
            : "Choose --remote for the migration target.",
          cause,
        ),
    });

    const sourcePath = resolveMigrationSourcePath(
      positionalSourcePath(context.args),
    );
    const repository = yield* Effect.try({
      try: () => repositoryForCurrentDirectory(),
      catch: (cause) =>
        migrationCommandError(
          "Could not determine the current Git repository.",
          cause,
        ),
    });
    const rows = yield* Effect.try({
      try: () => readLocalMigrationRows(sourcePath, repository),
      catch: (cause) =>
        migrationCommandError(
          cause instanceof Error
            ? cause.message
            : "Could not read the local database.",
          cause,
        ),
    });
    const remote = yield* Effect.tryPromise({
      try: () => loadDatabaseConfig(process.env, backendFlags),
      catch: (cause) =>
        migrationCommandError(
          cause instanceof Error
            ? cause.message
            : "Could not load remote credentials.",
          cause,
        ),
    });
    if (remote.kind !== "remote") {
      return yield* Effect.fail(
        migrationCommandError(
          "Local export requires configured remote credentials. Run 'machine-memory remote setup'.",
        ),
      );
    }

    const targetIds = new Map<number, number>();
    let summary = emptyBatchResult();
    for (const batch of chunks(rows, ROW_BATCH_SIZE)) {
      const result = yield* migrateRemoteRows(
        remote.url,
        remote.token,
        repository,
        batch,
      ).pipe(
        Effect.mapError((cause) => migrationCommandError(cause.message, cause)),
      );
      for (const item of result.items) {
        targetIds.set(item.source_id, item.target_id);
      }
      summary = {
        processed: summary.processed + result.processed,
        inserted: summary.inserted + result.inserted,
        duplicates: summary.duplicates + result.duplicates,
        items: [...summary.items, ...result.items],
      };
    }

    const links = rows.flatMap((row) => {
      if (row.superseded_by_source_id === null) {
        return [];
      }
      const targetId = targetIds.get(row.source_id);
      const supersededByTargetId = targetIds.get(row.superseded_by_source_id);
      return targetId === undefined || supersededByTargetId === undefined
        ? []
        : [
            {
              target_id: targetId,
              superseded_by_target_id: supersededByTargetId,
            },
          ];
    });
    for (const batch of chunks(links, LINK_BATCH_SIZE)) {
      yield* migrateRemoteLinks(
        remote.url,
        remote.token,
        repository,
        batch,
      ).pipe(
        Effect.mapError((cause) => migrationCommandError(cause.message, cause)),
      );
    }

    yield* updateAgentsMdForRemote(context);

    yield* Effect.sync(() => {
      console.info();
      console.info(pc.green(pc.bold("✓ Local export completed")));
      console.info(`${pc.dim("Source")}     ${sourcePath}`);
      console.info(`${pc.dim("Repository")} ${repository}`);
      console.info(`${pc.dim("Processed")}  ${summary.processed}`);
      console.info(`${pc.dim("Inserted")}   ${summary.inserted}`);
      console.info(
        `${pc.dim("Skipped")}    ${summary.duplicates} exact duplicates`,
      );
      console.info(
        `${pc.dim("Links")}      ${links.length} superseded_by links updated`,
      );
      console.info(`${pc.dim("Agents")}     AGENTS.md updated for --remote`);
      console.info();
      console.info(`${pc.dim("Next")}       machine-memory reindex --remote`);
      console.info();
    });
  });
}

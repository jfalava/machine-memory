import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import {
  decodeRequest,
  MigrationRequestInputSchema,
  normalizeMigrationRequest,
} from "@machine-memory/contract";
import { Effect } from "effect";
import pc from "picocolors";

import { getFlagValue } from "../../cli-utils";
import {
  loadDatabaseConfig,
  validateDatabaseBackendFlags,
} from "../../database-config";
import { commandError } from "../../effect/errors";
import {
  migrateRemoteLinks,
  migrateRemoteRows,
  type RemoteMigrationBatchResult,
} from "../../effect/remote-migration";
import {
  readLocalMigrationRows,
  resolveMigrationSourcePath,
} from "../../remote-migration";
import { repositoryForCurrentDirectory } from "../../repository";
import type { CommandContext } from "../runtime/context";
import { collectPositionalArgs } from "../shared";
import { replaceMemoryBlock } from "./agents-md-content";

const ROW_BATCH_SIZE = 50;
const LINK_BATCH_SIZE = 100;

function migrationCommandError(
  message: string,
  cause?: unknown,
  hint?: string,
) {
  return commandError("local export", message, cause, hint);
}

function positionalSourcePath(args: string[]): string | undefined {
  return collectPositionalArgs(args, ["--source-id"])[0];
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
      migrationCommandError(
        "Could not update AGENTS.md for --remote.",
        cause,
        "Check that AGENTS.md is writable in this directory.",
      ),
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
          "machine-memory local export [local-db-path] --remote",
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
          "Run the command from a Git repository.",
        ),
    });
    const { rows, source } = yield* Effect.try({
      try: () => {
        const sourceRows = readLocalMigrationRows(sourcePath, repository);
        const sourceId =
          getFlagValue(context.args, "--source-id") ??
          createHash("sha256")
            .update(`${hostname()}:${realpathSync(sourcePath)}`)
            .digest("hex");
        // Validate every batch before starting any remote writes.
        for (const batch of chunks(sourceRows, ROW_BATCH_SIZE)) {
          const input = decodeRequest(MigrationRequestInputSchema, {
            repository,
            source: sourceId,
            rows: batch,
          });
          if (!input.ok) {
            throw new Error(input.error);
          }
          const normalized = normalizeMigrationRequest(input.value);
          if (!normalized.ok) {
            throw new Error(normalized.error);
          }
        }
        const ids = new Set(sourceRows.map((row) => row.source_id));
        for (const row of sourceRows) {
          if (
            row.superseded_by_source_id !== null &&
            (row.superseded_by_source_id === row.source_id ||
              !ids.has(row.superseded_by_source_id))
          ) {
            throw new Error(
              `Unresolved replacement for source id ${row.source_id}.`,
            );
          }
        }
        return { rows: sourceRows, source: sourceId };
      },
      catch: (cause) =>
        migrationCommandError(
          cause instanceof Error
            ? cause.message
            : "Could not read the local database.",
          cause,
          "Pass a local database path or set MACHINE_MEMORY_DB_PATH.",
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
          "Set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKEN, or run machine-memory remote setup.",
        ),
    });
    if (remote.kind !== "remote") {
      return yield* migrationCommandError(
        "Local export requires configured remote credentials.",
        undefined,
        "Set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKEN, or run machine-memory remote setup.",
      );
    }

    const targetIds = new Map<number, number>();
    let summary = emptyBatchResult();
    for (const batch of chunks(rows, ROW_BATCH_SIZE)) {
      const result = yield* migrateRemoteRows(
        remote.url,
        remote.token,
        repository,
        source,
        batch,
      ).pipe(
        Effect.mapError((cause) =>
          migrationCommandError(
            cause.message,
            cause,
            "Confirm the Worker URL and token with machine-memory remote setup.",
          ),
        ),
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
        Effect.mapError((cause) =>
          migrationCommandError(
            cause.message,
            cause,
            "Confirm the Worker URL and token with machine-memory remote setup.",
          ),
        ),
      );
    }

    yield* updateAgentsMdForRemote(context);

    yield* Effect.sync(() => {
      console.info();
      console.info(pc.green(pc.bold("✓ Local export completed")));
      console.info(`${pc.dim("Source")}     ${sourcePath}`);
      console.info(`${pc.dim("Source ID")}  ${source}`);
      console.info(`${pc.dim("Repository")} ${repository}`);
      console.info(`${pc.dim("Processed")}  ${summary.processed}`);
      console.info(`${pc.dim("Inserted")}   ${summary.inserted}`);
      console.info(
        `${pc.dim("Skipped")}    ${summary.duplicates} previously imported source IDs`,
      );
      console.info(
        `${pc.dim("Links")}      ${links.length} superseded_by links updated`,
      );
      console.info(`${pc.dim("Agents")}     AGENTS.md updated for --remote`);
      console.info();
      console.info(
        `${pc.dim("Indexing")}   queued automatically; search visibility is asynchronous`,
      );
      console.info();
    });
  });
}

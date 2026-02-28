import { Database } from "bun:sqlite";
import { getFlagValue, printJson, usageError } from "../../cli";
import { runWithRetry } from "../../db";
import { suggestTagsForPath } from "../../path-tags";
import {
  ADD_FLAGS_WITH_VALUES,
  ADD_USAGE,
  DEPRECATE_FLAGS_WITH_VALUES,
  DEPRECATE_USAGE,
  UPDATE_FLAGS_WITH_VALUES,
  UPDATE_USAGE,
  collectPositionalArgs,
  detectPotentialConflicts,
  findMemoryByMatch,
  findStatusCascadeCandidates,
  getMemoryById,
  hasMinimalOutput,
  mergeTagValues,
  parseContentFromFileFlag,
  parseIdSpec,
  parseIntegerFlag,
  parseRefsFlag,
  requireCertainty,
  requireMemoryType,
} from "../shared";
import type { CommandContext } from "./context";

type AddMetadata = {
  mappedTags: string[];
  tags: string;
  memo: string;
  memoryType: string;
  certainty: string;
  sourceAgent: string;
  updatedBy: string;
  refs: string[];
  expiresAfterDays: number | null | undefined;
};

type UpdateTargets = {
  targetIds: number[];
  contentFromArg: string | undefined;
};

type UpdateSpec = {
  clause: string;
  value: string | number | null;
};

function resolveAddContent(args: string[]): string {
  const positional = collectPositionalArgs(args, ADD_FLAGS_WITH_VALUES);
  const contentFromArg = positional[0];
  const contentFromFile = parseContentFromFileFlag(args);
  if (contentFromArg && contentFromFile !== undefined) {
    usageError(`Usage: ${ADD_USAGE}`);
  }
  const content = contentFromFile ?? contentFromArg;
  if (!content) {
    usageError(`Usage: ${ADD_USAGE}`);
  }
  return content;
}

function resolveAddMetadata(args: string[]): AddMetadata {
  const explicitTags = getFlagValue(args, "--tags");
  const pathContext = getFlagValue(args, "--path");
  const mappedTags = pathContext ? suggestTagsForPath(pathContext) : [];
  const sourceAgent = getFlagValue(args, "--source-agent") ?? "";
  return {
    mappedTags,
    tags: mergeTagValues(explicitTags, mappedTags),
    memo: getFlagValue(args, "--context") ?? "",
    memoryType: requireMemoryType(args) ?? "convention",
    certainty: requireCertainty(args) ?? "inferred",
    sourceAgent,
    updatedBy: getFlagValue(args, "--updated-by") ?? sourceAgent,
    refs: parseRefsFlag(args) ?? [],
    expiresAfterDays: parseIntegerFlag(args, "--expires-after-days"),
  };
}

function detectAddConflicts(
  database: Database,
  outputMode: CommandContext["outputMode"],
  content: string,
  metadata: AddMetadata,
): {
  includeConflicts: boolean;
  potentialConflicts: Record<string, unknown>[];
} {
  const includeConflicts = !(
    outputMode.noConflicts || hasMinimalOutput(outputMode)
  );
  return {
    includeConflicts,
    potentialConflicts: includeConflicts
      ? detectPotentialConflicts(database, {
          content,
          tags: metadata.tags,
          context: metadata.memo,
        })
      : [],
  };
}

function addInsert(database: Database, content: string, metadata: AddMetadata) {
  return runWithRetry(
    database,
    `INSERT INTO memories (
     content, tags, context, memory_type, certainty, status, superseded_by,
     source_agent, last_updated_by, update_count, refs, expires_after_days
   ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, 0, ?, ?)`,
    [
      content,
      metadata.tags,
      metadata.memo,
      metadata.memoryType,
      metadata.certainty,
      metadata.sourceAgent,
      metadata.updatedBy,
      JSON.stringify(metadata.refs),
      metadata.expiresAfterDays ?? null,
    ],
  );
}

function printAddResult(params: {
  outputMode: CommandContext["outputMode"];
  createdId: number;
  created: Record<string, unknown> | null;
  content: string;
  metadata: AddMetadata;
  includeConflicts: boolean;
  potentialConflicts: Record<string, unknown>[];
  statusCascade: Record<string, unknown>[];
}) {
  const {
    outputMode,
    createdId,
    created,
    content,
    metadata,
    includeConflicts,
    potentialConflicts,
    statusCascade,
  } = params;
  if (outputMode.jsonMin || outputMode.quiet) {
    printJson({ id: createdId });
    return;
  }
  if (outputMode.brief) {
    printJson({
      id: createdId,
      status: "created",
      conflict_count: potentialConflicts.length,
      status_cascade_count: statusCascade.length,
    });
    return;
  }

  const payload: Record<string, unknown> = {
    ...(created ?? {
      id: createdId,
      content,
      tags: metadata.tags,
      context: metadata.memo,
    }),
  };
  if (metadata.mappedTags.length > 0) {
    payload.path_tag_suggestions = metadata.mappedTags;
  }
  if (includeConflicts) {
    payload.potential_conflicts = potentialConflicts;
  }
  if (statusCascade.length > 0) {
    const staleIds = statusCascade.map((item) => Number(item.id));
    payload.status_cascade = {
      overlapping_ids: staleIds,
      suggested_command: `machine-memory deprecate ${staleIds.join(",")} --superseded-by ${createdId}`,
    };
  }
  printJson(payload);
}

export function handleAddCommand(commandCtx: CommandContext) {
  const { args, outputMode, requireDb } = commandCtx;
  const database = requireDb();
  const content = resolveAddContent(args);
  const metadata = resolveAddMetadata(args);
  const conflictState = detectAddConflicts(
    database,
    outputMode,
    content,
    metadata,
  );
  const result = addInsert(database, content, metadata);
  const created = getMemoryById(database, Number(result.lastInsertRowid));
  const createdId = Number(created?.id ?? result.lastInsertRowid);
  const statusCascade =
    metadata.memoryType === "status"
      ? findStatusCascadeCandidates(database, metadata.tags, createdId)
      : [];
  printAddResult({
    outputMode,
    createdId,
    created,
    content,
    metadata,
    includeConflicts: conflictState.includeConflicts,
    potentialConflicts: conflictState.potentialConflicts,
    statusCascade,
  });
}

function resolveUpdateTargets(
  args: string[],
  database: Database,
): UpdateTargets {
  const positional = collectPositionalArgs(args, UPDATE_FLAGS_WITH_VALUES);
  const matchQuery = getFlagValue(args, "--match");

  if (matchQuery !== undefined) {
    if (positional.length > 1) {
      usageError(`Usage: ${UPDATE_USAGE}`);
    }
    const contentFromArg = positional[0];
    const matched = findMemoryByMatch(database, matchQuery);
    if (!matched || typeof matched.id !== "number") {
      usageError(`No active memory matched --match "${matchQuery}".`);
    }
    return { targetIds: [Number(matched.id)], contentFromArg };
  }

  const idRaw = positional[0];
  const contentFromArg = positional.slice(1).join(" ");
  if (!idRaw) {
    usageError(`Usage: ${UPDATE_USAGE}`);
  }
  return { targetIds: parseIdSpec(idRaw), contentFromArg };
}

function resolveUpdateContent(
  args: string[],
  contentFromArg: string | undefined,
): string {
  const contentFromFile = parseContentFromFileFlag(args);
  if (contentFromArg && contentFromFile !== undefined) {
    usageError(`Usage: ${UPDATE_USAGE}`);
  }
  const content = contentFromFile ?? contentFromArg;
  if (!content) {
    usageError(`Usage: ${UPDATE_USAGE}`);
  }
  return content;
}

function optionalUpdateSpecs(args: string[]): UpdateSpec[] {
  const specs: UpdateSpec[] = [];
  const maybeSpecs: (UpdateSpec | undefined)[] = [
    (() => {
      const value = getFlagValue(args, "--tags");
      return value === undefined ? undefined : { clause: "tags = ?", value };
    })(),
    (() => {
      const value = getFlagValue(args, "--context");
      return value === undefined ? undefined : { clause: "context = ?", value };
    })(),
    (() => {
      const value = requireMemoryType(args);
      return value === undefined
        ? undefined
        : { clause: "memory_type = ?", value };
    })(),
    (() => {
      const value = requireCertainty(args);
      return value === undefined
        ? undefined
        : { clause: "certainty = ?", value };
    })(),
    (() => {
      const value = getFlagValue(args, "--updated-by");
      return value === undefined
        ? undefined
        : { clause: "last_updated_by = ?", value };
    })(),
    (() => {
      const value = parseRefsFlag(args);
      return value === undefined
        ? undefined
        : { clause: "refs = ?", value: JSON.stringify(value) };
    })(),
    (() => {
      const value = parseIntegerFlag(args, "--expires-after-days", {
        allowNullLiteral: true,
      });
      return value === undefined
        ? undefined
        : { clause: "expires_after_days = ?", value };
    })(),
  ];

  for (const spec of maybeSpecs) {
    if (spec) {
      specs.push(spec);
    }
  }
  return specs;
}

function updateSetsAndParams(args: string[], content: string) {
  const sets = [
    "content = ?",
    "updated_at = datetime('now')",
    "update_count = COALESCE(update_count, 0) + 1",
  ];
  const params: (string | number | null)[] = [content];
  for (const spec of optionalUpdateSpecs(args)) {
    sets.push(spec.clause);
    params.push(spec.value);
  }
  return { sets, params };
}

function runBatchMemoryUpdate(
  database: Database,
  targetIds: number[],
  sets: string[],
  params: (string | number | null)[],
): { rows: Record<string, unknown>[]; missingIds: number[] } {
  const rows: Record<string, unknown>[] = [];
  const missingIds: number[] = [];
  for (const targetId of targetIds) {
    runWithRetry(
      database,
      `UPDATE memories SET ${sets.join(", ")} WHERE id = ?`,
      [...params, targetId],
    );
    const updated = getMemoryById(database, targetId);
    if (updated) {
      rows.push(updated);
    } else {
      missingIds.push(targetId);
    }
  }
  return { rows, missingIds };
}

export function handleUpdateCommand(commandCtx: CommandContext) {
  const { args, requireDb } = commandCtx;
  const database = requireDb();
  const { targetIds, contentFromArg } = resolveUpdateTargets(args, database);
  const content = resolveUpdateContent(args, contentFromArg);
  if (targetIds.length === 0) {
    usageError(`Usage: ${UPDATE_USAGE}`);
  }

  const { sets, params } = updateSetsAndParams(args, content);
  const { rows, missingIds } = runBatchMemoryUpdate(
    database,
    targetIds,
    sets,
    params,
  );

  if (targetIds.length === 1) {
    printJson(rows[0] ?? { error: "Not found" });
    return;
  }

  printJson({
    updated: rows,
    not_found: missingIds,
    count: rows.length,
  });
}

function resolveDeprecateTargets(args: string[], database: Database): number[] {
  const positional = collectPositionalArgs(args, DEPRECATE_FLAGS_WITH_VALUES);
  const matchQuery = getFlagValue(args, "--match");

  if (matchQuery !== undefined) {
    if (positional.length > 0) {
      usageError(`Usage: ${DEPRECATE_USAGE}`);
    }
    const matched = findMemoryByMatch(database, matchQuery);
    if (!matched || typeof matched.id !== "number") {
      usageError(`No active memory matched --match "${matchQuery}".`);
    }
    return [Number(matched.id)];
  }

  const idRaw = positional.join(",");
  if (!idRaw.trim()) {
    usageError(`Usage: ${DEPRECATE_USAGE}`);
  }
  return parseIdSpec(idRaw);
}

function deprecateSetsAndParams(args: string[], targetIds: number[]) {
  const supersededBy = parseIntegerFlag(args, "--superseded-by");
  if (
    supersededBy !== undefined &&
    targetIds.some((targetId) => supersededBy === targetId)
  ) {
    usageError("A memory cannot supersede itself.");
  }
  const updatedBy = getFlagValue(args, "--updated-by");
  const sets = [
    "status = ?",
    "superseded_by = ?",
    "updated_at = datetime('now')",
    "update_count = COALESCE(update_count, 0) + 1",
  ];
  const params: (string | number | null)[] = [
    supersededBy !== undefined ? "superseded_by" : "deprecated",
    supersededBy ?? null,
  ];
  if (updatedBy !== undefined) {
    sets.push("last_updated_by = ?");
    params.push(updatedBy);
  }
  return { sets, params };
}

export function handleDeprecateCommand(commandCtx: CommandContext) {
  const { args, requireDb } = commandCtx;
  const database = requireDb();
  const targetIds = resolveDeprecateTargets(args, database);
  const { sets, params } = deprecateSetsAndParams(args, targetIds);
  const { rows, missingIds } = runBatchMemoryUpdate(
    database,
    targetIds,
    sets,
    params,
  );

  if (targetIds.length === 1) {
    printJson(rows[0] ?? { error: "Not found" });
    return;
  }

  printJson({
    deprecated: rows,
    not_found: missingIds,
    count: rows.length,
  });
}

export function handleDeleteCommand(commandCtx: CommandContext) {
  const { args, requireDb } = commandCtx;
  const database = requireDb();
  const idSpec = args.join(",");
  if (!idSpec.trim()) {
    usageError("Usage: delete <id|id,id,...>");
  }
  const ids = parseIdSpec(idSpec);
  for (const id of ids) {
    runWithRetry(database, "DELETE FROM memories WHERE id = ?", [id]);
  }
  if (ids.length === 1) {
    printJson({ deleted: ids[0] });
    return;
  }
  printJson({ deleted: ids, count: ids.length });
}

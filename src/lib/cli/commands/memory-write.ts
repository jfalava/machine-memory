/* eslint-disable max-statements, complexity */
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

type UpdateTargets = {
  targetIds: number[];
  contentFromArg: string | undefined;
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

function addInsert(
  database: Database,
  payload: {
    content: string;
    tags: string;
    context: string;
    memoryType: string;
    certainty: string;
    sourceAgent: string;
    updatedBy: string;
    refs: string[];
    expiresAfterDays: number | null | undefined;
  },
) {
  return runWithRetry(
    database,
    `INSERT INTO memories (
     content, tags, context, memory_type, certainty, status, superseded_by,
     source_agent, last_updated_by, update_count, refs, expires_after_days
   ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, 0, ?, ?)`,
    [
      payload.content,
      payload.tags,
      payload.context,
      payload.memoryType,
      payload.certainty,
      payload.sourceAgent,
      payload.updatedBy,
      JSON.stringify(payload.refs),
      payload.expiresAfterDays ?? null,
    ],
  );
}

function printAddResult(params: {
  outputMode: CommandContext["outputMode"];
  createdId: number;
  created: Record<string, unknown> | null;
  content: string;
  tags: string;
  memoContext: string;
  mappedTags: string[];
  includeConflicts: boolean;
  potentialConflicts: Record<string, unknown>[];
  statusCascade: Record<string, unknown>[];
}) {
  const {
    outputMode,
    createdId,
    created,
    content,
    tags,
    memoContext,
    mappedTags,
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
      tags,
      context: memoContext,
    }),
  };
  if (mappedTags.length > 0) {
    payload.path_tag_suggestions = mappedTags;
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

  const explicitTags = getFlagValue(args, "--tags");
  const pathContext = getFlagValue(args, "--path");
  const mappedTags = pathContext ? suggestTagsForPath(pathContext) : [];
  const tags = mergeTagValues(explicitTags, mappedTags);
  const memo = getFlagValue(args, "--context") ?? "";
  const memoryType = requireMemoryType(args) ?? "convention";
  const certainty = requireCertainty(args) ?? "inferred";
  const sourceAgent = getFlagValue(args, "--source-agent") ?? "";
  const updatedBy = getFlagValue(args, "--updated-by") ?? sourceAgent;
  const refs = parseRefsFlag(args) ?? [];
  const expiresAfterDays = parseIntegerFlag(args, "--expires-after-days");
  const includeConflicts = !(
    outputMode.noConflicts || hasMinimalOutput(outputMode)
  );
  const potentialConflicts = includeConflicts
    ? detectPotentialConflicts(database, {
        content,
        tags,
        context: memo,
      })
    : [];

  const result = addInsert(database, {
    content,
    tags,
    context: memo,
    memoryType,
    certainty,
    sourceAgent,
    updatedBy,
    refs,
    expiresAfterDays,
  });

  const created = getMemoryById(database, Number(result.lastInsertRowid));
  const createdId = Number(created?.id ?? result.lastInsertRowid);
  const statusCascade =
    memoryType === "status"
      ? findStatusCascadeCandidates(database, tags, createdId)
      : [];

  printAddResult({
    outputMode,
    createdId,
    created,
    content,
    tags,
    memoContext: memo,
    mappedTags,
    includeConflicts,
    potentialConflicts,
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

function updateSetsAndParams(args: string[], content: string) {
  const tags = getFlagValue(args, "--tags");
  const memo = getFlagValue(args, "--context");
  const memoryType = requireMemoryType(args);
  const certainty = requireCertainty(args);
  const updatedBy = getFlagValue(args, "--updated-by");
  const refs = parseRefsFlag(args);
  const expiresAfterDays = parseIntegerFlag(args, "--expires-after-days", {
    allowNullLiteral: true,
  });

  const sets = [
    "content = ?",
    "updated_at = datetime('now')",
    "update_count = COALESCE(update_count, 0) + 1",
  ];
  const params: (string | number | null)[] = [content];

  if (tags !== undefined) {
    sets.push("tags = ?");
    params.push(tags);
  }
  if (memo !== undefined) {
    sets.push("context = ?");
    params.push(memo);
  }
  if (memoryType !== undefined) {
    sets.push("memory_type = ?");
    params.push(memoryType);
  }
  if (certainty !== undefined) {
    sets.push("certainty = ?");
    params.push(certainty);
  }
  if (updatedBy !== undefined) {
    sets.push("last_updated_by = ?");
    params.push(updatedBy);
  }
  if (refs !== undefined) {
    sets.push("refs = ?");
    params.push(JSON.stringify(refs));
  }
  if (expiresAfterDays !== undefined) {
    sets.push("expires_after_days = ?");
    params.push(expiresAfterDays);
  }

  return { sets, params };
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

  const updatedRows: Record<string, unknown>[] = [];
  const missingIds: number[] = [];
  for (const targetId of targetIds) {
    runWithRetry(
      database,
      `UPDATE memories SET ${sets.join(", ")} WHERE id = ?`,
      [...params, targetId],
    );
    const updated = getMemoryById(database, targetId);
    if (updated) {
      updatedRows.push(updated);
    } else {
      missingIds.push(targetId);
    }
  }

  if (targetIds.length === 1) {
    printJson(updatedRows[0] ?? { error: "Not found" });
    return;
  }

  printJson({
    updated: updatedRows,
    not_found: missingIds,
    count: updatedRows.length,
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

export function handleDeprecateCommand(commandCtx: CommandContext) {
  const { args, requireDb } = commandCtx;
  const database = requireDb();
  const targetIds = resolveDeprecateTargets(args, database);
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

  const rows: Record<string, unknown>[] = [];
  const missingIds: number[] = [];
  for (const targetId of targetIds) {
    runWithRetry(
      database,
      `UPDATE memories SET ${sets.join(", ")} WHERE id = ?`,
      [...params, targetId],
    );
    const row = getMemoryById(database, targetId);
    if (row) {
      rows.push(row);
    } else {
      missingIds.push(targetId);
    }
  }

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

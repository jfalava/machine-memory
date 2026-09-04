import type {
  Certainty,
  MemoryStatus,
  MemoryType,
} from "@machine-memory/contract";

export type ProductFilters = {
  readonly status?: string;
  readonly memory_type?: string;
  readonly certainty?: string;
  readonly tags?: string;
};

export type VectorFilter = {
  status?: string;
  memory_type?: string;
  certainty?: string;
};

export function vectorFilter(filters: ProductFilters): VectorFilter {
  const filter: VectorFilter = {};
  if (filters.status !== undefined) {
    filter.status = filters.status;
  }
  if (filters.memory_type !== undefined) {
    filter.memory_type = filters.memory_type;
  }
  if (filters.certainty !== undefined) {
    filter.certainty = filters.certainty;
  }
  return filter;
}

export type ProductQuery = {
  readonly sql: string;
  readonly params: (string | number)[];
};

export function filterClauses(filters: ProductFilters, prefix: string): ProductQuery {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filters.status !== undefined) {
    clauses.push(`${prefix}status = ?`);
    params.push(filters.status);
  }
  if (filters.memory_type !== undefined) {
    clauses.push(`${prefix}memory_type = ?`);
    params.push(filters.memory_type);
  }
  if (filters.certainty !== undefined) {
    clauses.push(`${prefix}certainty = ?`);
    params.push(filters.certainty);
  }
  if (filters.tags !== undefined) {
    clauses.push(`${prefix}tags LIKE ?`);
    params.push(`%${filters.tags}%`);
  }
  return { sql: clauses.join(" AND "), params };
}

export function listSelect(
  repository: string,
  filters: ProductFilters,
  limit: number,
): ProductQuery {
  const base: ProductQuery = { sql: "repository = ?", params: [repository] };
  const extra = filterClauses(filters, "");
  const where = extra.sql.length > 0 ? `${base.sql} AND ${extra.sql}` : base.sql;
  return {
    sql: `SELECT * FROM memories WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    params: [...base.params, ...extra.params, limit],
  };
}

export function ftsSelect(
  ftsQuery: string,
  repository: string,
  filters: ProductFilters,
  limit: number,
): ProductQuery {
  const extra = filterClauses(filters, "m.");
  const where = extra.sql.length > 0
    ? `memories_fts MATCH ? AND m.repository = ? AND ${extra.sql}`
    : `memories_fts MATCH ? AND m.repository = ?`;
  return {
    sql: `SELECT m.*, bm25(memories_fts) AS fts_rank FROM memories m JOIN memories_fts ON m.id = memories_fts.rowid WHERE ${where} ORDER BY bm25(memories_fts) LIMIT ?`,
    params: [ftsQuery, repository, ...extra.params, limit],
  };
}

export function rowByIdSelect(repository: string, id: number): ProductQuery {
  return {
    sql: `SELECT * FROM memories WHERE repository = ? AND id = ?`,
    params: [repository, id],
  };
}

export function distinctRepositoriesSelect(limit: number): ProductQuery {
  return {
    sql: `SELECT DISTINCT repository FROM memories ORDER BY repository LIMIT ?`,
    params: [limit],
  };
}

export type NeighborhoodInput = {
  readonly repository: string;
  readonly filters: ProductFilters;
  readonly tagHints: string[];
  readonly pathHints: string[];
};

export function neighborhoodSelect(input: NeighborhoodInput): ProductQuery | undefined {
  const orClauses: string[] = [];
  const orParams: (string | number)[] = [];
  for (const tagHint of input.tagHints.slice(0, 10)) {
    orClauses.push("LOWER(m.tags) LIKE ?");
    orParams.push(`%${tagHint.toLowerCase()}%`);
  }
  for (const pathHint of input.pathHints.slice(0, 10)) {
    const lowered = `%${pathHint.toLowerCase()}%`;
    orClauses.push("LOWER(m.content) LIKE ?");
    orParams.push(lowered);
    orClauses.push("LOWER(m.context) LIKE ?");
    orParams.push(lowered);
  }
  if (orClauses.length === 0) {
    return undefined;
  }
  return neighborhoodWhere(input, orClauses, orParams);
}

function neighborhoodWhere(
  input: NeighborhoodInput,
  orClauses: string[],
  orParams: (string | number)[],
): ProductQuery {
  const clauses = [`(${orClauses.join(" OR ")})`, "m.repository = ?"];
  const params: (string | number)[] = [...orParams, input.repository];
  const extra = filterClauses(input.filters, "m.");
  const where = extra.sql.length > 0
    ? [...clauses, extra.sql].join(" AND ")
    : clauses.join(" AND ");
  return {
    sql: `SELECT m.*, 0 AS fts_rank FROM memories m WHERE ${where} ORDER BY m.updated_at DESC, m.id DESC LIMIT 30`,
    params: [...params, ...extra.params],
  };
}

export type InsertInput = {
  readonly repository: string;
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memory_type: MemoryType;
  readonly status: MemoryStatus;
  readonly certainty: Certainty;
  readonly expires_after_days: number | null;
};

export function insertParams(input: InsertInput): (string | number | null)[] {
  return [
    input.repository,
    input.content,
    input.tags,
    input.context,
    input.memory_type,
    input.status,
    "api",
    "api",
    input.certainty,
    "[]",
    input.expires_after_days,
  ];
}

export const INSERT_SQL = `INSERT INTO memories (repository, content, tags, context, memory_type, status, superseded_by, source_agent, last_updated_by, update_count, certainty, refs, expires_after_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, datetime('now'), datetime('now'))`;

export type UpdateFields = {
  readonly content?: string;
  readonly tags?: string;
  readonly context?: string;
  readonly memory_type?: string;
  readonly certainty?: string;
  readonly status?: string;
  readonly expires_after_days?: number;
  readonly superseded_by?: number;
};

export function updateSets(fields: UpdateFields): ProductQuery | undefined {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (fields.content !== undefined) {
    sets.push("content = ?");
    params.push(fields.content);
  }
  if (fields.tags !== undefined) {
    sets.push("tags = ?");
    params.push(fields.tags);
  }
  if (fields.context !== undefined) {
    sets.push("context = ?");
    params.push(fields.context);
  }
  if (fields.memory_type !== undefined) {
    sets.push("memory_type = ?");
    params.push(fields.memory_type);
  }
  if (fields.certainty !== undefined) {
    sets.push("certainty = ?");
    params.push(fields.certainty);
  }
  return finishUpdateSets(sets, params, fields);
}

function finishUpdateSets(
  sets: string[],
  params: (string | number)[],
  fields: UpdateFields,
): ProductQuery | undefined {
  if (fields.status !== undefined) {
    sets.push("status = ?");
    params.push(fields.status);
  }
  if (fields.expires_after_days !== undefined) {
    sets.push("expires_after_days = ?");
    params.push(fields.expires_after_days);
  }
  if (fields.superseded_by !== undefined) {
    sets.push("superseded_by = ?");
    params.push(fields.superseded_by);
  }
  if (sets.length === 0) {
    return undefined;
  }
  sets.push("updated_at = datetime('now')");
  sets.push("update_count = COALESCE(update_count, 0) + 1");
  return { sql: sets.join(", "), params };
}

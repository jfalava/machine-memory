import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

type PathTagMap = Record<string, string[]>;

function normalizePath(value: string): string {
  const normalized = value
    .replaceAll("\\", "/")
    .trim()
    .replace(/^\.\/+/, "");
  if (!normalized) {
    return "";
  }
  return normalized;
}

function normalizeTags(tags: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of tags) {
    const cleaned = rawTag.trim();
    if (!cleaned) {
      continue;
    }
    const lowered = cleaned.toLowerCase();
    if (seen.has(lowered)) {
      continue;
    }
    seen.add(lowered);
    unique.push(cleaned);
  }
  return unique;
}

export function pathTagMapFilePath(cwd = process.cwd()): string {
  return resolve(cwd, ".agents", "path-tags.json");
}

export function loadPathTagMap(cwd = process.cwd()): PathTagMap {
  const filePath = pathTagMapFilePath(cwd);
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const next: PathTagMap = {};
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [rawPrefix, value] of entries) {
    const prefix = normalizePath(rawPrefix);
    if (!prefix) {
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    const tags = normalizeTags(
      value.filter((item): item is string => typeof item === "string"),
    );
    if (tags.length > 0) {
      next[prefix] = tags;
    }
  }
  return next;
}

export function savePathTagMap(map: PathTagMap, cwd = process.cwd()) {
  const filePath = pathTagMapFilePath(cwd);
  const directory = dirname(filePath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(filePath, String(JSON.stringify(map, null, 2)), "utf-8");
}

export function upsertPathTagMapEntry(
  pathPrefix: string,
  tags: string[],
  cwd = process.cwd(),
): PathTagMap {
  const map = loadPathTagMap(cwd);
  const prefix = normalizePath(pathPrefix);
  if (!prefix) {
    return map;
  }
  const normalized = normalizeTags(tags);
  if (normalized.length > 0) {
    map[prefix] = normalized;
  }
  savePathTagMap(map, cwd);
  return map;
}

export function deletePathTagMapEntry(
  pathPrefix: string,
  cwd = process.cwd(),
): PathTagMap {
  const map = loadPathTagMap(cwd);
  const prefix = normalizePath(pathPrefix);
  if (prefix in map) {
    delete map[prefix];
    savePathTagMap(map, cwd);
  }
  return map;
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  if (path === prefix) {
    return true;
  }
  if (prefix.endsWith("/")) {
    return path.startsWith(prefix);
  }
  return path.startsWith(prefix) || path.startsWith(`${prefix}/`);
}

export function suggestTagsForPath(
  path: string,
  cwd = process.cwd(),
): string[] {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) {
    return [];
  }
  const map = loadPathTagMap(cwd);
  const entries = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
  const tags: string[] = [];
  for (const [prefix, mappedTags] of entries) {
    if (!pathMatchesPrefix(normalizedPath, prefix)) {
      continue;
    }
    for (const tag of mappedTags) {
      tags.push(tag);
    }
  }
  return normalizeTags(tags);
}

import { execFileSync } from "node:child_process";

import { repositorySlugError } from "@machine-memory/contract";

let cachedRepository: string | undefined;

type RepositoryTarget = {
  /** Slug from --repo or MACHINE_MEMORY_REPO; undefined infers it from Git. */
  readonly slug: string | undefined;
  /** --allow-new-repo: writes may start a repository that has no memories. */
  readonly allowNew: boolean;
};

let repositoryTarget: RepositoryTarget = { slug: undefined, allowNew: false };

/** Validates an explicit slug from --repo or MACHINE_MEMORY_REPO. */
export function parseRepositorySlug(value: string): string {
  const slug = value.trim();
  const error = repositorySlugError(slug);
  if (error !== undefined) {
    throw new Error(
      `Invalid repository '${value}': ${error} Example: --repo jfalava/machine-memory.`,
    );
  }
  return slug;
}

/** Process-wide target for every repository-scoped command in this run. */
export function setRepositoryTarget(target: RepositoryTarget): void {
  repositoryTarget = target;
}

/** True when --repo or MACHINE_MEMORY_REPO names the repository. */
export function repositoryIsExplicit(): boolean {
  return repositoryTarget.slug !== undefined;
}

export function allowsNewRepository(): boolean {
  return repositoryTarget.allowNew;
}

/**
 * Repositories worth naming when `slug` has no memories: those whose
 * name starts like its name (or the reverse) or whose path is the tail of its
 * path (or the reverse), else every known repository.
 */
export function similarRepositories(
  slug: string,
  known: readonly string[],
): string[] {
  const key = (value: string) => value.replace(/^@/, "").toLowerCase();
  const name = (value: string) => key(value).split("/").at(-1) ?? "";
  const target = key(slug);
  const others = known.filter((candidate) => candidate !== slug);
  const similar = others.filter((candidate) => {
    const other = key(candidate);
    return (
      name(candidate).startsWith(name(slug)) ||
      name(slug).startsWith(name(candidate)) ||
      other.endsWith(`/${target}`) ||
      target.endsWith(`/${other}`)
    );
  });
  return similar.length > 0 ? similar : others;
}

/**
 * The repository commands act on: --repo or MACHINE_MEMORY_REPO when given,
 * otherwise the path of the current checkout's origin remote.
 */
export function repositoryForCurrentDirectory(cwd = process.cwd()): string {
  if (repositoryTarget.slug !== undefined) {
    return repositoryTarget.slug;
  }
  if (cachedRepository !== undefined && cwd === process.cwd()) {
    return cachedRepository;
  }

  let remote: string;
  try {
    remote = String(
      execFileSync("git", ["config", "--get", "remote.origin.url"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).trim();
  } catch (cause) {
    throw new Error(
      "Could not infer the repository from Git remote.origin.url. Run this command inside a Git checkout with an origin remote.",
      { cause },
    );
  }

  const repository = parseRepositoryRemote(remote);
  if (!repository) {
    throw new Error(
      `Could not infer a repository slug from Git remote '${remote}'. Pass --repo <slug>.`,
    );
  }

  if (cwd === process.cwd()) {
    cachedRepository = repository;
  }
  return repository;
}

/** The slug for a Git remote URL, or undefined when its path is not one. */
export function parseRepositoryRemote(remote: string): string | undefined {
  const normalized = remote
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (!normalized) {
    return undefined;
  }

  let path: string;
  const scpStyle = normalized.match(/^[^@/:]+@[^:]+:(.+)$/);
  if (scpStyle?.[1]) {
    path = scpStyle[1];
  } else {
    try {
      path = new URL(normalized).pathname;
    } catch {
      return undefined;
    }
  }

  // The whole path is the identity, so a GitLab subgroup keeps every segment.
  const slug = path.split("/").filter(Boolean).join("/");
  return repositorySlugError(slug) === undefined ? slug : undefined;
}

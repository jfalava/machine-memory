import { execFileSync } from "node:child_process";

import { MAX_NAMESPACE_BYTES } from "@machine-memory/contract";

let cachedRepository: string | undefined;

type RepositoryOverride = {
  readonly slug: string;
  readonly allowNew: boolean;
};

let repositoryOverride: RepositoryOverride | undefined;

const REPOSITORY_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Validates an explicit owner/name slug from --repo or MACHINE_MEMORY_REPO. */
export function parseRepositorySlug(value: string): string {
  const slug = value.trim();
  if (
    !REPOSITORY_SLUG.test(slug) ||
    new TextEncoder().encode(slug).byteLength > MAX_NAMESPACE_BYTES
  ) {
    throw new Error(
      `Invalid repository '${value}'. Use an owner/name slug of at most ${MAX_NAMESPACE_BYTES} bytes, e.g. --repo jfalava/machine-memory.`,
    );
  }
  return slug;
}

/** Process-wide target for every repository-scoped command in this run. */
export function setRepositoryOverride(
  override: RepositoryOverride | undefined,
): void {
  repositoryOverride = override;
}

export function activeRepositoryOverride(): RepositoryOverride | undefined {
  return repositoryOverride;
}

/**
 * The repository commands act on: --repo or MACHINE_MEMORY_REPO when given,
 * otherwise the current checkout's origin remote, normalized to owner/name.
 */
export function repositoryForCurrentDirectory(cwd = process.cwd()): string {
  if (repositoryOverride !== undefined) {
    return repositoryOverride.slug;
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
      `Could not infer an owner/name repository from Git remote '${remote}'.`,
    );
  }

  if (cwd === process.cwd()) {
    cachedRepository = repository;
  }
  return repository;
}

function parseRepositoryRemote(remote: string): string | undefined {
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

  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  const owner = parts.at(-2);
  const name = parts.at(-1);
  return owner && name ? `${owner}/${name}` : undefined;
}

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { repositorySlugError } from "@machine-memory/contract";
import { Schema } from "effect";

/** Where a slug came from: --repo or MACHINE_MEMORY_REPO, the pin file, or the origin remote. */
export type RepositorySource = "explicit" | "pin" | "origin";

let cachedRepository: ResolvedRepository | undefined;

type RepositoryTarget = {
  /** Slug from --repo or MACHINE_MEMORY_REPO; undefined infers it from Git. */
  readonly slug: string | undefined;
  /** --allow-new-repo: writes may start a repository that has no memories. */
  readonly allowNew: boolean;
  /** The other repositories of a read across several: --repo a,b. */
  readonly others?: readonly string[];
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

/** Validates --repo or MACHINE_MEMORY_REPO, which may list several slugs for a read. */
export function parseRepositoryList(value: string): string[] {
  const slugs = value.split(",").map((slug) => parseRepositorySlug(slug));
  return [...new Set(slugs)];
}

/** Commands that read several repositories at once with --repo a,b. */
const MULTI_REPOSITORY_COMMANDS = new Set(["query", "get", "list"]);

/** Why `command` cannot run on the repository list of this run, if it cannot. */
export function repositoryListError(
  command: string | undefined,
): string | undefined {
  const count = 1 + (repositoryTarget.others?.length ?? 0);
  if (
    repositoryTarget.slug === undefined ||
    count === 1 ||
    (command !== undefined && MULTI_REPOSITORY_COMMANDS.has(command))
  ) {
    return undefined;
  }
  return `--repo lists ${count} repositories, and only query, get and list read several at once. Run '${command ?? "this command"}' once per repository with --repo <slug>.`;
}

/** The repositories a read covers: one, or the list given to --repo. */
export function readRepositories(): string[] {
  return [repositoryForCurrentDirectory(), ...(repositoryTarget.others ?? [])];
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

function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    return String(
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).trim();
  } catch {
    return undefined;
  }
}

/**
 * The committed pin file: at the top of the Git checkout, so it is found from
 * any subdirectory, or in `cwd` outside a checkout.
 */
export function repositoryPinPath(cwd = process.cwd()): string {
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
  return join(root, ".agents", "machine-memory.json");
}

const decodePin = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ repository: Schema.String })),
);

/** The slug `init` pinned for this checkout, or undefined when there is no pin file. */
export function readRepositoryPin(cwd = process.cwd()): string | undefined {
  const path = repositoryPinPath(cwd);
  if (!existsSync(path)) {
    return undefined;
  }
  let pinned: string;
  try {
    pinned = decodePin(readFileSync(path, "utf8")).repository.trim();
  } catch (cause) {
    throw new Error(
      `${path} is not a repository pin. It must hold {"repository": "<slug>"}; run 'machine-memory init' to rewrite it, or delete it.`,
      { cause },
    );
  }
  const error = repositorySlugError(pinned);
  if (error !== undefined) {
    throw new Error(`${path} pins an invalid repository '${pinned}': ${error}`);
  }
  return pinned;
}

/** The pin file's content for `slug`. */
export function repositoryPinContent(slug: string): string {
  return `${JSON.stringify({ repository: slug }, null, 2)}\n`;
}

/** Where the slug of this run comes from. */
export function repositorySource(cwd = process.cwd()): RepositorySource {
  repositoryForCurrentDirectory(cwd);
  return repositoryTarget.slug !== undefined
    ? "explicit"
    : (cachedRepository?.source ?? "origin");
}

/**
 * The repository commands act on, from the first of: --repo,
 * MACHINE_MEMORY_REPO, the pin file `init` writes, and the path of the
 * checkout's origin remote.
 */
export function repositoryForCurrentDirectory(cwd = process.cwd()): string {
  if (repositoryTarget.slug !== undefined) {
    return repositoryTarget.slug;
  }
  if (cachedRepository !== undefined && cwd === process.cwd()) {
    return cachedRepository.slug;
  }
  const resolved = resolveRepository(cwd);
  if (cwd === process.cwd()) {
    cachedRepository = resolved;
  }
  return resolved.slug;
}

type ResolvedRepository = {
  readonly slug: string;
  readonly source: RepositorySource;
};

function resolveRepository(cwd: string): ResolvedRepository {
  const pinned = readRepositoryPin(cwd);
  if (pinned !== undefined) {
    return { slug: pinned, source: "pin" };
  }

  const remote = gitOutput(cwd, ["config", "--get", "remote.origin.url"]);
  if (remote === undefined) {
    throw new Error(
      "Could not infer the repository: there is no pin file and no Git remote.origin.url. Pass --repo <slug>, or run this command inside a Git checkout with an origin remote.",
    );
  }

  const repository = parseRepositoryRemote(remote);
  if (!repository) {
    throw new Error(
      `Could not infer a repository slug from Git remote '${remote}'. Pass --repo <slug>.`,
    );
  }

  return { slug: repository, source: "origin" };
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

import { execFileSync } from "node:child_process";

let cachedRepository: string | undefined;

/**
 * Infer the repository identity from the current checkout's origin remote.
 * The value is normalized to the final owner/name path, without `.git`.
 */
export function repositoryForCurrentDirectory(cwd = process.cwd()): string {
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

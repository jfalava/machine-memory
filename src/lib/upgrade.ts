import { Effect, FileSystem, PlatformError } from "effect";
import { REPO, VERSION } from "./constants";

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type Release = {
  tag_name: string;
  assets: ReleaseAsset[];
};

export class UpgradeError extends Error {
  readonly _tag = "UpgradeError";

  constructor(readonly payload: Record<string, unknown>) {
    super(
      typeof payload.error === "string" ? payload.error : "Upgrade failed.",
    );
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function apiBase(): string {
  return (
    process.env["MACHINE_MEMORY_API_URL"] ??
    `https://api.github.com/repos/${REPO}`
  );
}

function binaryPath(): string {
  return process.env["MACHINE_MEMORY_BIN_PATH"] ?? process.execPath;
}

function requestTimeoutMs(): number {
  const raw = process.env["MACHINE_MEMORY_UPGRADE_TIMEOUT_MS"];
  if (!raw) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

function platformAssetName(): string {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `machine-memory-${platform}-${arch}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : "Unknown error";
}

function promiseEffect<T>(
  operation: string,
  run: () => Promise<T>,
): Effect.Effect<T, UpgradeError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof UpgradeError
        ? cause
        : new UpgradeError({ error: `${operation}: ${errorMessage(cause)}` }),
  });
}

function fetchWithTimeout(
  url: string,
  requestLabel: string,
  timeoutMs: number,
  init?: RequestInit,
): Effect.Effect<Response, UpgradeError> {
  return promiseEffect(requestLabel, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new UpgradeError({
          error: `${requestLabel}: request timed out after ${timeoutMs}ms`,
        });
      }
      throw new UpgradeError({
        error: `${requestLabel}: ${errorMessage(cause)}`,
      });
    } finally {
      clearTimeout(timer);
    }
  });
}

function fetchLatestRelease(
  timeoutMs: number,
): Effect.Effect<Release, UpgradeError> {
  return Effect.gen(function* () {
    const response = yield* fetchWithTimeout(
      `${apiBase()}/releases/latest`,
      "Failed to fetch latest release",
      timeoutMs,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!response.ok) {
      return yield* Effect.fail(
        new UpgradeError({
          error: `Failed to fetch latest release: ${response.status}`,
        }),
      );
    }
    return yield* promiseEffect(
      "Failed to decode latest release",
      () => response.json() as Promise<Release>,
    );
  });
}

function selectAsset(
  release: Release,
): Effect.Effect<ReleaseAsset, UpgradeError> {
  const assetName = platformAssetName();
  const asset = release.assets.find(
    (candidate) => candidate.name === assetName,
  );
  return asset
    ? Effect.succeed(asset)
    : Effect.fail(
        new UpgradeError({
          error: `No binary found for ${assetName}`,
          available: release.assets.map((candidate) => candidate.name),
        }),
      );
}

function downloadToTemp(
  asset: ReleaseAsset,
  tempPath: string,
  timeoutMs: number,
): Effect.Effect<
  void,
  UpgradeError | PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const response = yield* fetchWithTimeout(
      asset.browser_download_url,
      "Download failed",
      timeoutMs,
    );
    if (!response.ok) {
      return yield* Effect.fail(
        new UpgradeError({ error: `Download failed: ${response.status}` }),
      );
    }
    const buffer = yield* promiseEffect("Download failed", () =>
      response.arrayBuffer(),
    );
    yield* fileSystem.writeFile(tempPath, new Uint8Array(buffer));
    yield* fileSystem.chmod(tempPath, 0o755);
  });
}

function replaceBinary(
  tempPath: string,
): Effect.Effect<
  void,
  UpgradeError | PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  const targetPath = binaryPath();
  const backupPath = `${targetPath}.bak`;
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const replace = Effect.gen(function* () {
      yield* fileSystem.rename(targetPath, backupPath);
      yield* fileSystem.rename(tempPath, targetPath);
      yield* fileSystem.remove(backupPath);
    });

    yield* replace.pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          if (yield* fileSystem.exists(backupPath)) {
            yield* fileSystem.rename(backupPath, targetPath);
          }
          if (yield* fileSystem.exists(tempPath)) {
            yield* fileSystem.remove(tempPath);
          }
          return yield* Effect.fail(
            new UpgradeError({
              error: `Upgrade failed: ${errorMessage(cause)}`,
            }),
          );
        }).pipe(
          Effect.catch((cleanupCause) =>
            Effect.fail(
              new UpgradeError({
                error: `Upgrade failed: ${errorMessage(cause)}; cleanup failed: ${errorMessage(cleanupCause)}`,
              }),
            ),
          ),
        ),
      ),
    );
  });
}

export function upgrade(): Effect.Effect<
  Record<string, unknown>,
  UpgradeError | PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const release = yield* fetchLatestRelease(requestTimeoutMs());
    const latest = release.tag_name.replace(/^v/, "");
    if (latest === VERSION) {
      return { message: "Already up to date", version: VERSION };
    }

    const asset = yield* selectAsset(release);
    const tempPath = `${binaryPath()}.tmp`;
    yield* downloadToTemp(asset, tempPath, requestTimeoutMs());
    yield* replaceBinary(tempPath);
    return { message: "Upgraded", from: VERSION, to: latest };
  });
}

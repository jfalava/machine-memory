import { Effect, FileSystem, PlatformError } from "effect";
import { inflateRawSync } from "node:zlib";
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

export type UpgradeProgress =
  | { phase: "checking" }
  | {
      phase: "found";
      currentVersion: string;
      latestVersion: string;
      updateAvailable: boolean;
    }
  | { phase: "downloading"; assetName: string }
  | { phase: "installing" };

export type UpgradeOptions = {
  onProgress?: (progress: UpgradeProgress) => void;
};

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

export function assetNameForPlatform(
  platform: string,
  arch: string,
): string | undefined {
  const platformName =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : undefined;
  if (!platformName) {
    return undefined;
  }
  const architecture =
    arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (!architecture) {
    return undefined;
  }
  return `machine-memory-${platformName}-${architecture}.zip`;
}

export function binaryNameForPlatform(platform: string): string | undefined {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    return undefined;
  }
  return platform === "win32" ? "machine-memory.exe" : "machine-memory";
}

function platformAssetName(): string | undefined {
  return assetNameForPlatform(process.platform, process.arch);
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
  if (!assetName) {
    return Effect.fail(
      new UpgradeError({
        error: `Unsupported upgrade platform: ${process.platform}/${process.arch}`,
      }),
    );
  }
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

type ZipDirectory = {
  entryCount: number;
  offset: number;
  end: number;
};

type ZipEntry = {
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localFileOffset: number;
  name: string;
  nextOffset: number;
};

function uint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function uint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function findZipDirectory(
  archive: Uint8Array,
  view: DataView,
): ZipDirectory {
  const endOfCentralDirectorySignature = 0x06054b50;
  const minimumEndRecordSize = 22;
  const maximumCommentSize = 0xffff;
  const searchStart = Math.max(
    0,
    archive.length - minimumEndRecordSize - maximumCommentSize,
  );
  let endOffset = -1;

  for (let offset = archive.length - minimumEndRecordSize; offset >= searchStart; offset -= 1) {
    if (uint32(view, offset) === endOfCentralDirectorySignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error("Downloaded release is not a valid ZIP archive.");
  }

  const entryCount = uint16(view, endOffset + 10);
  const centralDirectorySize = uint32(view, endOffset + 12);
  const centralDirectoryOffset = uint32(view, endOffset + 16);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryEnd > archive.length) {
    throw new Error("Downloaded release has an invalid ZIP directory.");
  }
  return { entryCount, offset: centralDirectoryOffset, end: centralDirectoryEnd };
}

function readZipEntry(
  archive: Uint8Array,
  view: DataView,
  offset: number,
): ZipEntry {
  if (uint32(view, offset) !== 0x02014b50) {
    throw new Error("Downloaded release has an invalid ZIP entry.");
  }

  const fileNameLength = uint16(view, offset + 28);
  const extraFieldLength = uint16(view, offset + 30);
  const commentLength = uint16(view, offset + 32);
  const fileNameStart = offset + 46;
  const fileNameEnd = fileNameStart + fileNameLength;
  const nextOffset = fileNameEnd + extraFieldLength + commentLength;
  if (nextOffset > archive.length) {
    throw new Error("Downloaded release has a truncated ZIP entry.");
  }
  return {
    compressionMethod: uint16(view, offset + 10),
    compressedSize: uint32(view, offset + 20),
    uncompressedSize: uint32(view, offset + 24),
    localFileOffset: uint32(view, offset + 42),
    name: new TextDecoder().decode(archive.subarray(fileNameStart, fileNameEnd)),
    nextOffset,
  };
}

function extractZipEntry(
  archive: Uint8Array,
  view: DataView,
  entry: ZipEntry,
): Uint8Array {
  if (uint32(view, entry.localFileOffset) !== 0x04034b50) {
    throw new Error("Downloaded release has an invalid executable entry.");
  }
  const localFileNameLength = uint16(view, entry.localFileOffset + 26);
  const localExtraFieldLength = uint16(view, entry.localFileOffset + 28);
  const dataStart =
    entry.localFileOffset + 30 + localFileNameLength + localExtraFieldLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > archive.length) {
    throw new Error("Downloaded release has a truncated executable entry.");
  }

  const compressed = archive.subarray(dataStart, dataEnd);
  const binary =
    entry.compressionMethod === 0
      ? compressed
      : entry.compressionMethod === 8
        ? new Uint8Array(inflateRawSync(compressed))
        : undefined;
  if (!binary) {
    throw new Error(
      `Downloaded release uses unsupported ZIP compression method ${entry.compressionMethod}.`,
    );
  }
  if (binary.byteLength !== entry.uncompressedSize) {
    throw new Error("Downloaded release executable size does not match its ZIP entry.");
  }
  return binary;
}

/** Extract the normalized executable from the single-file release ZIP. */
export function extractZipBinary(
  archive: Uint8Array,
  expectedName: string,
): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const directory = findZipDirectory(archive, view);
  let offset = directory.offset;
  for (let entry = 0; entry < directory.entryCount && offset < directory.end; entry += 1) {
    const zipEntry = readZipEntry(archive, view, offset);
    if (zipEntry.name === expectedName) {
      return extractZipEntry(archive, view, zipEntry);
    }
    offset = zipEntry.nextOffset;
  }
  throw new Error(`Downloaded release does not contain ${expectedName}.`);
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
    const archive = new Uint8Array(
      yield* promiseEffect("Download failed", () => response.arrayBuffer()),
    );
    const expectedBinary = binaryNameForPlatform(process.platform);
    if (!expectedBinary) {
      return yield* Effect.fail(
        new UpgradeError({
          error: `Unsupported upgrade platform: ${process.platform}/${process.arch}`,
        }),
      );
    }
    const binary = yield* promiseEffect("Archive extraction failed", async () =>
      extractZipBinary(archive, expectedBinary),
    );
    yield* fileSystem.writeFile(tempPath, binary);
    if (process.platform !== "win32") {
      yield* fileSystem.chmod(tempPath, 0o755);
    }
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
    if (process.platform === "win32") {
      const helper = Bun.spawn({
        cmd: [
          "powershell.exe",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "$target = $env:MACHINE_MEMORY_UPGRADE_TARGET; $temp = $env:MACHINE_MEMORY_UPGRADE_TEMP; $ownerPid = [int]$env:MACHINE_MEMORY_UPGRADE_PID; while (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 100 }; Move-Item -LiteralPath $temp -Destination $target -Force",
        ],
        env: {
          ...process.env,
          MACHINE_MEMORY_UPGRADE_TARGET: targetPath,
          MACHINE_MEMORY_UPGRADE_TEMP: tempPath,
          MACHINE_MEMORY_UPGRADE_PID: String(process.pid),
        },
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      });
      if (!helper.pid) {
        return yield* Effect.fail(
          new UpgradeError({
            error: "Failed to start Windows upgrade helper.",
          }),
        );
      }
      return;
    }
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

export function upgrade(
  options: UpgradeOptions = {},
): Effect.Effect<
  Record<string, unknown>,
  UpgradeError | PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    options.onProgress?.({ phase: "checking" });
    const release = yield* fetchLatestRelease(requestTimeoutMs());
    const latest = release.tag_name.replace(/^v/, "");
    options.onProgress?.({
      phase: "found",
      currentVersion: VERSION,
      latestVersion: latest,
      updateAvailable: latest !== VERSION,
    });
    if (latest === VERSION) {
      return { message: "Already up to date", version: VERSION };
    }

    const asset = yield* selectAsset(release);
    const tempPath = `${binaryPath()}.tmp`;
    options.onProgress?.({ phase: "downloading", assetName: asset.name });
    yield* downloadToTemp(asset, tempPath, requestTimeoutMs());
    options.onProgress?.({ phase: "installing" });
    yield* replaceBinary(tempPath);
    return { message: "Upgraded", from: VERSION, to: latest };
  });
}

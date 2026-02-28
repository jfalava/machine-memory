import { chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { printJson } from "./cli";
import { REPO, VERSION } from "./constants";

type ReleaseAsset = { name: string; browser_download_url: string };
type Release = { tag_name: string; assets: ReleaseAsset[] };

const API_BASE =
  process.env["MACHINE_MEMORY_API_URL"] ??
  `https://api.github.com/repos/${REPO}`;
const BIN_PATH = process.env["MACHINE_MEMORY_BIN_PATH"] ?? process.execPath;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function requestTimeoutMs(): number {
  const raw = process.env["MACHINE_MEMORY_UPGRADE_TIMEOUT_MS"];
  if (!raw) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return parsed;
}

function getPlatformAssetName(): string {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `machine-memory-${platform}-${arch}`;
}

function failAndExit(message: string): never {
  printJson({ error: message });
  process.exit(1);
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return "Unknown error";
}

async function fetchWithTimeout(
  url: string,
  requestLabel: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      failAndExit(`${requestLabel}: request timed out after ${timeoutMs}ms`);
    }
    failAndExit(`${requestLabel}: ${formatErrorMessage(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLatestRelease(timeoutMs: number): Promise<Release> {
  const res = await fetchWithTimeout(
    `${API_BASE}/releases/latest`,
    "Failed to fetch latest release",
    timeoutMs,
    {
      headers: { Accept: "application/vnd.github+json" },
    },
  );
  if (!res.ok) {
    failAndExit(`Failed to fetch latest release: ${res.status}`);
  }
  return (await res.json()) as Release;
}

function selectAssetOrExit(release: Release): ReleaseAsset {
  const assetName = getPlatformAssetName();
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    printJson({
      error: `No binary found for ${assetName}`,
      available: release.assets.map((a) => a.name),
    });
    process.exit(1);
  }
  return asset;
}

async function downloadToTemp(
  asset: ReleaseAsset,
  tmpPath: string,
  timeoutMs: number,
) {
  const download = await fetchWithTimeout(
    asset.browser_download_url,
    "Download failed",
    timeoutMs,
  );
  if (!download.ok) {
    failAndExit(`Download failed: ${download.status}`);
  }
  const { writeFile } = await import("node:fs/promises");
  const buffer = new Uint8Array(await download.arrayBuffer());
  await writeFile(tmpPath, buffer);
  chmodSync(tmpPath, 0o755);
}

function replaceBinary(tmpPath: string) {
  const backupPath = `${BIN_PATH}.bak`;
  try {
    renameSync(BIN_PATH, backupPath);
    renameSync(tmpPath, BIN_PATH);
    unlinkSync(backupPath);
  } catch (e) {
    if (existsSync(backupPath)) {
      renameSync(backupPath, BIN_PATH);
    }
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }
    throw e;
  }
}

export async function upgrade() {
  const timeoutMs = requestTimeoutMs();
  const release = await fetchLatestRelease(timeoutMs);

  const latest = release.tag_name.replace(/^v/, "");
  if (latest === VERSION) {
    printJson({ message: "Already up to date", version: VERSION });
    return;
  }

  const asset = selectAssetOrExit(release);

  const tmpPath = `${BIN_PATH}.tmp`;
  await downloadToTemp(asset, tmpPath, timeoutMs);
  replaceBinary(tmpPath);

  printJson({ message: "Upgraded", from: VERSION, to: latest });
}

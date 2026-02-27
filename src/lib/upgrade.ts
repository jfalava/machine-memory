import { chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { printJson } from "./cli";
import { REPO, VERSION } from "./constants";

type ReleaseAsset = { name: string; browser_download_url: string };
type Release = { tag_name: string; assets: ReleaseAsset[] };

const API_BASE =
  process.env["MACHINE_MEMORY_API_URL"] ??
  `https://api.github.com/repos/${REPO}`;
const BIN_PATH = process.env["MACHINE_MEMORY_BIN_PATH"] ?? process.execPath;

function getPlatformAssetName(): string {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `machine-memory-${platform}-${arch}`;
}

function failAndExit(message: string) {
  printJson({ error: message });
  process.exit(1);
}

async function fetchLatestRelease(): Promise<Release> {
  const res = await fetch(`${API_BASE}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
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

async function downloadToTemp(asset: ReleaseAsset, tmpPath: string) {
  const download = await fetch(asset.browser_download_url);
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
  const release = await fetchLatestRelease();

  const latest = release.tag_name.replace(/^v/, "");
  if (latest === VERSION) {
    printJson({ message: "Already up to date", version: VERSION });
    return;
  }

  const asset = selectAssetOrExit(release);

  const tmpPath = `${BIN_PATH}.tmp`;
  await downloadToTemp(asset, tmpPath);
  replaceBinary(tmpPath);

  printJson({ message: "Upgraded", from: VERSION, to: latest });
}

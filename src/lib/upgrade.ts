import { chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { printJson } from "./cli";
import { REPO, VERSION } from "./constants";

const API_BASE =
  process.env["MACHINE_MEMORY_API_URL"] ??
  `https://api.github.com/repos/${REPO}`;
const BIN_PATH = process.env["MACHINE_MEMORY_BIN_PATH"] ?? process.execPath;

function getPlatformAssetName(): string {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `machine-memory-${platform}-${arch}`;
}

export async function upgrade() {
  const res = await fetch(`${API_BASE}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    printJson({ error: `Failed to fetch latest release: ${res.status}` });
    process.exit(1);
  }

  const release = (await res.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };

  const latest = release.tag_name.replace(/^v/, "");
  if (latest === VERSION) {
    printJson({ message: "Already up to date", version: VERSION });
    return;
  }

  const assetName = getPlatformAssetName();
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    printJson({
      error: `No binary found for ${assetName}`,
      available: release.assets.map((a) => a.name),
    });
    process.exit(1);
  }

  const tmpPath = `${BIN_PATH}.tmp`;

  const download = await fetch(asset.browser_download_url);
  if (!download.ok) {
    printJson({ error: `Download failed: ${download.status}` });
    process.exit(1);
  }

  const { writeFile } = await import("node:fs/promises");
  const buffer = new Uint8Array(await download.arrayBuffer());
  await writeFile(tmpPath, buffer);
  chmodSync(tmpPath, 0o755);

  try {
    renameSync(BIN_PATH, `${BIN_PATH}.bak`);
    renameSync(tmpPath, BIN_PATH);
    unlinkSync(`${BIN_PATH}.bak`);
  } catch (e) {
    if (existsSync(`${BIN_PATH}.bak`)) {
      renameSync(`${BIN_PATH}.bak`, BIN_PATH);
    }
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }
    throw e;
  }

  printJson({ message: "Upgraded", from: VERSION, to: latest });
}

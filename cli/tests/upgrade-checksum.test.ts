import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  assetNameForPlatform,
  binaryNameForPlatform,
  extractZipBinary,
  parseChecksums,
  sha256Hex,
  UpgradeError,
  verifyArchiveChecksum,
} from "@/upgrade";

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

async function expectUpgradeError(
  effect: Effect.Effect<unknown, UpgradeError>,
): Promise<string> {
  const error = await Effect.runPromise(Effect.flip(effect));
  expect(error).toBeInstanceOf(UpgradeError);
  return error.message;
}

describe("sha256Hex", () => {
  it("computes the expected digest", () => {
    expect(sha256Hex(bytes("hello"))).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("parseChecksums", () => {
  it("parses sha256sum output with binary-mode variants", () => {
    const checksums = parseChecksums(
      [
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  machine-memory-linux-x64.zip",
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9 *machine-memory-windows-x64.zip",
        "",
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("machine-memory-linux-x64.zip")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(checksums.get("machine-memory-windows-x64.zip")).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
    expect(checksums.size).toBe(2);
  });
});

describe("verifyArchiveChecksum", () => {
  const archive = bytes("archive-bytes");
  const archiveSha = sha256Hex(archive);
  const asset = {
    name: "machine-memory-linux-x64.zip",
    browser_download_url: "https://example.com/machine-memory-linux-x64.zip",
  };

  it("accepts a matching GitHub asset digest", async () => {
    await Effect.runPromise(
      verifyArchiveChecksum(
        archive,
        { tag_name: "v1", assets: [] },
        {
          ...asset,
          digest: `sha256:${archiveSha}`,
        },
      ),
    );
  });
  it("rejects a mismatching asset digest", async () => {
    const message = await expectUpgradeError(
      verifyArchiveChecksum(
        archive,
        { tag_name: "v1", assets: [] },
        {
          ...asset,
          digest: `sha256:${"0".repeat(64)}`,
        },
      ),
    );
    expect(message).toContain("Checksum mismatch");
    expect(message).toContain(archiveSha);
  });

  it("falls back to the checksums.txt asset when no digest is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            `${archiveSha}  machine-memory-linux-x64.zip\n${"1".repeat(64)}  other.zip\n`,
            { status: 200 },
          ),
      ),
    );
    try {
      await Effect.runPromise(
        verifyArchiveChecksum(
          archive,
          {
            tag_name: "v1",
            assets: [
              {
                name: "checksums.txt",
                browser_download_url: "https://example.com/checksums.txt",
              },
            ],
          },
          asset,
        ),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed when neither digest nor checksums.txt is available", async () => {
    const message = await expectUpgradeError(
      verifyArchiveChecksum(archive, { tag_name: "v1", assets: [] }, asset),
    );
    expect(message).toContain("Unable to verify the checksum");
  });
});

describe("release platform selection", () => {
  it("selects the published asset for each supported target", () => {
    expect(assetNameForPlatform("darwin", "arm64")).toBe(
      "machine-memory-darwin-arm64.zip",
    );
    expect(assetNameForPlatform("linux", "x64")).toBe(
      "machine-memory-linux-x64.zip",
    );
    expect(assetNameForPlatform("win32", "x64")).toBe(
      "machine-memory-windows-x64.zip",
    );
    expect(assetNameForPlatform("freebsd", "x64")).toBeUndefined();
  });

  it("uses normalized executable names inside release archives", () => {
    expect(binaryNameForPlatform("darwin")).toBe("machine-memory");
    expect(binaryNameForPlatform("linux")).toBe("machine-memory");
    expect(binaryNameForPlatform("win32")).toBe("machine-memory.exe");
    expect(binaryNameForPlatform("freebsd")).toBeUndefined();
  });

  it("extracts the expected executable from a stored ZIP archive", () => {
    const name = new TextEncoder().encode("machine-memory-linux-x64");
    const contents = new TextEncoder().encode("binary");
    const local = new Uint8Array(30 + name.length + contents.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(18, contents.length, true);
    localView.setUint32(22, contents.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(contents, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(20, contents.length, true);
    centralView.setUint32(24, contents.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, 0, true);
    central.set(name, 46);

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, 1, true);
    endView.setUint16(10, 1, true);
    endView.setUint32(12, central.length, true);
    endView.setUint32(16, local.length, true);

    const archive = new Uint8Array(local.length + central.length + end.length);
    archive.set(local, 0);
    archive.set(central, local.length);
    archive.set(end, local.length + central.length);

    expect(extractZipBinary(archive, "machine-memory")).toEqual(contents);
    expect(extractZipBinary(archive, "machine-memory-linux-x64")).toEqual(
      contents,
    );
  });
});

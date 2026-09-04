import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
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
      verifyArchiveChecksum(archive, { tag_name: "v1", assets: [] }, {
        ...asset,
        digest: `sha256:${archiveSha}`,
      }),
    );
  });
  it("rejects a mismatching asset digest", async () => {
    const message = await expectUpgradeError(
      verifyArchiveChecksum(archive, { tag_name: "v1", assets: [] }, {
        ...asset,
        digest: `sha256:${"0".repeat(64)}`,
      }),
    );
    expect(message).toContain("Checksum mismatch");
    expect(message).toContain(archiveSha);
  });

  it("falls back to the checksums.txt asset when no digest is present", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `${archiveSha}  machine-memory-linux-x64.zip\n${"1".repeat(64)}  other.zip\n`,
        { status: 200 },
      )) as unknown as typeof fetch;
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
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when neither digest nor checksums.txt is available", async () => {
    const message = await expectUpgradeError(
      verifyArchiveChecksum(archive, { tag_name: "v1", assets: [] }, asset),
    );
    expect(message).toContain("Unable to verify the checksum");
  });
});

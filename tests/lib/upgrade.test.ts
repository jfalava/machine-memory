import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { VERSION } from "../../src/lib/constants";
import { createCliHarness } from "../_support/cli-harness";

const harness = createCliHarness();
const { execAsync, jsonAsync, getTestDir, setEnv } = harness;

let mockHandler: (req: IncomingMessage, res: ServerResponse) => void = (
  _req,
  res,
) => {
  res.writeHead(500);
  res.end();
};

const mockServer = createServer((req, res) => {
  mockHandler(req, res);
});
mockServer.listen(0);
mockServer.unref();
const mockPort = (mockServer.address() as { port: number }).port;

function mockJson(res: ServerResponse, statusCode: number, body: unknown) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

afterAll(() => {
  mockServer.close();
});

describe("upgrade", () => {
  let fakeBinPath: string;

  beforeEach(() => {
    fakeBinPath = join(getTestDir(), "machine-memory-fake");
    writeFileSync(fakeBinPath, "original-binary-content");
    setEnv("MACHINE_MEMORY_API_URL", `http://localhost:${mockPort}`);
    setEnv("MACHINE_MEMORY_BIN_PATH", fakeBinPath);
  });

  test("reports already up to date when versions match", async () => {
    mockHandler = (_req, res) => {
      mockJson(res, 200, { tag_name: `v${VERSION}`, assets: [] });
    };
    const result = (await jsonAsync("upgrade")) as Record<string, unknown>;
    expect(result.message).toBe("Already up to date");
    expect(result.version).toBe(VERSION);
  });

  test("errors when API returns non-200", async () => {
    mockHandler = (_req, res) => {
      res.writeHead(404);
      res.end("Not Found");
    };
    const result = await execAsync("upgrade");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(result.exitCode).toBe(1);
    expect(parsed.error).toContain("Failed to fetch latest release: 404");
  });

  test("errors when release request times out", async () => {
    setEnv("MACHINE_MEMORY_UPGRADE_TIMEOUT_MS", "50");
    mockHandler = () => {
      // Intentionally never respond to simulate a stalled network request.
    };

    const result = await execAsync("upgrade");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.exitCode).toBe(1);
    expect(parsed.error).toContain(
      "Failed to fetch latest release: request timed out after 50ms",
    );
  });

  test("errors when no matching binary for platform", async () => {
    mockHandler = (_req, res) => {
      mockJson(res, 200, {
        tag_name: "v99.0.0",
        assets: [
          { name: "machine-memory-fake-arch", browser_download_url: "" },
        ],
      });
    };
    const result = await execAsync("upgrade");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(result.exitCode).toBe(1);
    expect(parsed.error).toContain("No binary found");
    expect(parsed.available).toEqual(["machine-memory-fake-arch"]);
  });

  test("errors when binary download fails", async () => {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const assetName = `machine-memory-${platform}-${arch}`;

    mockHandler = (req, res) => {
      if (req.url?.includes("/releases/latest")) {
        mockJson(res, 200, {
          tag_name: "v99.0.0",
          assets: [
            {
              name: assetName,
              browser_download_url: `http://localhost:${mockPort}/download`,
            },
          ],
        });
        return;
      }
      res.writeHead(500);
      res.end("Server Error");
    };
    const result = await execAsync("upgrade");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(result.exitCode).toBe(1);
    expect(parsed.error).toContain("Download failed: 500");
  });

  test("successfully downloads and replaces binary", async () => {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const assetName = `machine-memory-${platform}-${arch}`;
    const newContent = "new-binary-content-v2";

    mockHandler = (req, res) => {
      if (req.url?.includes("/releases/latest")) {
        mockJson(res, 200, {
          tag_name: "v2.0.0",
          assets: [
            {
              name: assetName,
              browser_download_url: `http://localhost:${mockPort}/download`,
            },
          ],
        });
        return;
      }
      res.writeHead(200);
      res.end(newContent);
    };

    const result = (await jsonAsync("upgrade")) as Record<string, unknown>;
    expect(result.message).toBe("Upgraded");
    expect(result.from).toBe(VERSION);
    expect(result.to).toBe("2.0.0");

    const replaced = readFileSync(fakeBinPath, "utf-8");
    expect(replaced).toBe(newContent);

    expect(existsSync(`${fakeBinPath}.bak`)).toBe(false);
    expect(existsSync(`${fakeBinPath}.tmp`)).toBe(false);
  });

  test("does not create database", async () => {
    mockHandler = (_req, res) => {
      mockJson(res, 200, { tag_name: `v${VERSION}`, assets: [] });
    };
    await execAsync("upgrade");
    expect(existsSync(join(getTestDir(), ".agents", "memory.db"))).toBe(false);
  });
});

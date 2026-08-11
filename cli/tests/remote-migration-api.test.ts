import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  migrateRemoteLinks,
  migrateRemoteRows,
} from "@/effect/remote-migration";

afterEach(() => {
  vi.unstubAllGlobals();
});

const row = {
  source_id: 7,
  content: "Remote migration is explicit",
  tags: "architecture",
  context: "",
  memory_type: "decision",
  status: "active",
  superseded_by_source_id: null,
  source_agent: "",
  last_updated_by: "",
  update_count: 0,
  certainty: "verified",
  refs: "[]",
  expires_after_days: null,
  created_at: null,
  updated_at: null,
};

describe("remote migration API", () => {
  it("posts rows to the dedicated migration endpoint and parses mappings", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              processed: 1,
              inserted: 1,
              duplicates: 0,
              items: [{ source_id: 7, target_id: 42, status: "inserted" }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await Effect.runPromise(
      migrateRemoteRows(
        "https://memory.example/query",
        "secret",
        "owner/project",
        [row],
      ),
    );

    expect(result.items[0]).toEqual({
      source_id: 7,
      target_id: 42,
      status: "inserted",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://memory.example/migrate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      repository: "owner/project",
      rows: [row],
    });
  });

  it("posts superseded_by link updates to the dedicated endpoint", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, result: { updated: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      migrateRemoteLinks(
        "https://memory.example/query",
        "secret",
        "owner/project",
        [{ target_id: 42, superseded_by_target_id: 43 }],
      ),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://memory.example/migrate/links",
      expect.any(Object),
    );
  });
});

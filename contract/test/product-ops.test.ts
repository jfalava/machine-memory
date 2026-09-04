import { describe, expect, it } from "vitest";
import {
  CLI_LIMIT_MAX,
  decodeRequest,
  MemoryAddArgsInputSchema,
  MemoryQueryArgsInputSchema,
  normalizeMemoryAddArgs,
  normalizeMemoryQueryArgs,
  SEARCH_LIMIT_MAX,
} from "../src/index";

describe("product ops schemas", () => {
  it("documents the limit split", () => {
    expect(SEARCH_LIMIT_MAX).toBe(50);
    expect(CLI_LIMIT_MAX).toBe(100);
  });

  it("defaults query mode to hybrid and limit to 8", () => {
    const result = decodeRequest(MemoryQueryArgsInputSchema, {
      repository: "owner/name",
      query: "deploy",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const normalized = normalizeMemoryQueryArgs(result.value);
      expect(normalized.mode).toBe("hybrid");
      expect(normalized.limit).toBe(8);
    }
  });

  it("defaults add enums and upsert threshold", () => {
    const result = decodeRequest(MemoryAddArgsInputSchema, {
      repository: "owner/name",
      content: "remember this",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const normalized = normalizeMemoryAddArgs(result.value);
      expect(normalized.memory_type).toBe("convention");
      expect(normalized.certainty).toBe("inferred");
      expect(normalized.status).toBe("active");
      expect(normalized.upsert_threshold).toBe(32);
    }
  });
});

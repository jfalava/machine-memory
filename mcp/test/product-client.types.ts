import type {
  MemoryDeprecateSuccess,
  MemoryGetSuccess,
  MemoryStatsSuccess,
} from "@machine-memory/contract";
import { postProduct, type ApiFetcher } from "../src/mcp/product-client";

// Checked by tsc, never executed. A route determines both its body and result.
export function checkProductClientTypes(api: ApiFetcher): void {
  const get: Promise<MemoryGetSuccess> = postProduct(api, "token", "get", {
    repository: "o/r",
    id: 1,
  });
  void get;
  const stats: Promise<MemoryStatsSuccess> = postProduct(
    api,
    "token",
    "stats",
    { repository: "o/r" },
  );
  void stats;
  const deprecate: Promise<MemoryDeprecateSuccess> = postProduct(
    api,
    "token",
    "deprecate",
    { repository: "o/r", ids: [1, 2], superseded_by: 3 },
  );
  void deprecate;
  void postProduct(api, "token", "delete", {
    repository: "o/r",
    // @ts-expect-error delete requires an id, not a query
    query: "deploy",
  });
  // @ts-expect-error get requires a repository
  void postProduct(api, "token", "get", { id: 1 });
  // @ts-expect-error delete does not return a memory row
  const wrong: Promise<MemoryGetSuccess> = postProduct(api, "token", "delete", {
    repository: "o/r",
    id: 1,
  });
  void wrong;
}

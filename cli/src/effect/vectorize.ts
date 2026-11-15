import {
  decodeResponse,
  VectorizeSearchResultSchema,
  type VectorizeSearchRequestInput,
} from "@machine-memory/contract";
import type { Effect } from "effect";

import type { JsonObject, JsonValue } from "../json";
import type { MemoryDatabaseError } from "./errors";
import { apiUrl, postJson, toContractValue } from "./remote-http";

export type MemoryVectorDocument = {
  readonly id: string;
  readonly repository: string;
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memory_type: string;
  readonly status: string;
  readonly certainty: string;
};

export type MemoryVectorMatch = {
  readonly id: string;
  readonly score: number;
  readonly metadata: JsonObject;
};

export type MemoryVectorSearchResult = {
  readonly count: number;
  readonly matches: MemoryVectorMatch[];
};

export type MemoryVectorApi = {
  readonly search: (
    request: MemoryVectorSearchRequest,
  ) => Effect.Effect<MemoryVectorSearchResult, MemoryDatabaseError>;
};

export type MemoryVectorSearchRequest = VectorizeSearchRequestInput;

function parseSearchResult(value: JsonValue): MemoryVectorSearchResult {
  const result = decodeResponse(
    VectorizeSearchResultSchema,
    toContractValue(value),
    "vectorize/search",
  );
  if (result === undefined) {
    throw new Error("Remote vector API returned an invalid search result.");
  }
  return {
    count: result.count,
    matches: result.matches.map((match) => ({
      id: match.id,
      score: match.score,
      metadata: match.metadata ?? {},
    })),
  };
}

export function remoteVectorApi(
  queryUrl: string,
  token: string | undefined,
): MemoryVectorApi {
  return {
    search: (searchRequest) =>
      postJson({
        url: apiUrl(queryUrl, "/vectorize/search"),
        token,
        body: searchRequest,
        operation: "vectorize/search",
        service: "Remote vector API",
        fallbackMessage: "Remote vector operation failed.",
        errorLabel: "vectorize/error",
        parse: (payload) => parseSearchResult(payload.result),
      }),
  };
}

import {
  decodeResponse,
  ErrorBodySchema,
  VectorizeSearchResultSchema,
  type VectorizeSearchRequestInput,
  type JsonValue as ContractJsonValue,
} from "@machine-memory/contract";
import { Effect } from "effect";

import {
  jsonObject,
  jsonString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "../json";
import type { EmbeddingTextPart } from "./bge-tokenizer";
import { MemoryDatabaseError } from "./errors";

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

export function memoryVectorEmbeddingParts(
  document: MemoryVectorDocument,
): EmbeddingTextPart[] {
  return [
    { part: "content", text: document.content },
    { part: "tags", text: document.tags ? `Tags: ${document.tags}` : "" },
    {
      part: "context",
      text: document.context ? `Context: ${document.context}` : "",
    },
    { part: "memory_type", text: `Memory type: ${document.memory_type}` },
    { part: "status", text: `Status: ${document.status}` },
    { part: "certainty", text: `Certainty: ${document.certainty}` },
  ];
}

type RemoteVectorResponse = JsonObject;

type RequestHeaders = {
  "content-type": string;
  authorization?: string;
};

async function readRemoteResponse(
  response: Response,
): Promise<RemoteVectorResponse> {
  const text = await response.text();
  try {
    const parsed = jsonObject(parseJson(text));
    if (parsed === undefined) {
      throw new Error("response was not a JSON object");
    }
    return parsed;
  } catch (cause) {
    const contentType = response.headers.get("content-type") ?? "unknown";
    throw new Error(
      `Remote vector API returned non-JSON HTTP ${response.status} (${contentType}).`,
      { cause },
    );
  }
}

function vectorError(operation: string, cause: unknown): MemoryDatabaseError {
  return new MemoryDatabaseError({
    operation,
    message:
      cause instanceof Error
        ? cause.message
        : "Remote vector operation failed.",
    cause,
  });
}

function vectorUrl(queryUrl: string, path: string): string {
  const parsed = new URL(queryUrl);
  const basePath = parsed.pathname.replace(/\/query\/?$/, "");
  parsed.pathname = `${basePath}${path}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function toContractValue(value: JsonValue): ContractJsonValue {
  // SAFETY: parsed JSON response values carry no undefined entries.
  return value as ContractJsonValue;
}

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

type RequestOptions<T> = {
  readonly queryUrl: string;
  readonly token: string | undefined;
  readonly operation: string;
  readonly path: string;
  readonly body: JsonValue;
  readonly parse: (value: JsonValue) => T;
};

function request<T>(
  options: RequestOptions<T>,
): Effect.Effect<T, MemoryDatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      const headers: RequestHeaders = { "content-type": "application/json" };
      if (options.token) {
        headers.authorization = `Bearer ${options.token}`;
      }
      // HTTP boundary; errors are typed by tryPromise's catch.
      // @effect-diagnostics-next-line globalFetchInEffect:off
      const response = await fetch(vectorUrl(options.queryUrl, options.path), {
        method: "POST",
        headers,
        body: JSON.stringify(options.body),
      });
      const payload = await readRemoteResponse(response);
      if (!response.ok || payload.ok !== true) {
        const failure = decodeResponse(
          ErrorBodySchema,
          toContractValue(payload),
          "vectorize/error",
        );
        const message =
          failure?.error ??
          jsonString(payload.error) ??
          `Remote vector API returned HTTP ${response.status}.`;
        throw new Error(message);
      }
      return options.parse(payload.result);
    },
    catch: (cause) => vectorError(options.operation, cause),
  });
}

export function remoteVectorApi(
  queryUrl: string,
  token: string | undefined,
): MemoryVectorApi {
  return {
    search: (searchRequest) =>
      request({
        queryUrl,
        token,
        operation: "vectorize/search",
        path: "/vectorize/search",
        body: searchRequest,
        parse: parseSearchResult,
      }),
  };
}

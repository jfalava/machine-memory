import { Effect } from "effect";
import {
  jsonNumber,
  jsonObject,
  jsonString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "../json";
import { MemoryDatabaseError } from "./errors";
import {
  composeEmbeddingText,
  validateBgeEmbeddingText,
  type EmbeddingTextPart,
} from "./bge-tokenizer";

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

export type MemoryVectorMutation = {
  readonly id: string;
  readonly namespace?: string;
  readonly mutationId: string;
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
  readonly upsert: (
    document: MemoryVectorDocument,
  ) => Effect.Effect<MemoryVectorMutation, MemoryDatabaseError>;
  readonly delete: (
    id: string,
  ) => Effect.Effect<MemoryVectorMutation, MemoryDatabaseError>;
  readonly search: (
    request: MemoryVectorSearchRequest,
  ) => Effect.Effect<MemoryVectorSearchResult, MemoryDatabaseError>;
};

export type MemoryVectorSearchRequest = {
  readonly repository: string;
  readonly query: string;
  readonly top_k: number;
  readonly status?: string;
  readonly memory_type?: string;
  readonly certainty?: string;
};

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

export function memoryVectorEmbeddingText(
  document: MemoryVectorDocument,
): string {
  return composeEmbeddingText(memoryVectorEmbeddingParts(document));
}

type RemoteVectorResponse = JsonObject;

type RequestHeaders = {
  "content-type": string;
  authorization?: string;
};

type RemoteRequestError = Error & {
  readonly status?: number;
  readonly retryAfterMs?: number;
};

export type VectorizeRateLimitInfo = {
  readonly retryAfterMs?: number;
};

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? undefined
    : Math.max(0, timestamp - Date.now());
}

function remoteRequestError(
  response: Response,
  message: string,
): RemoteRequestError {
  // SAFETY: status and retryAfterMs are attached via defineProperties right below,
  // satisfying RemoteRequestError.
  const error = new Error(message) as RemoteRequestError;
  Object.defineProperties(error, {
    status: { value: response.status, enumerable: false },
    retryAfterMs: {
      value: parseRetryAfterMs(response.headers.get("retry-after")),
      enumerable: false,
    },
  });
  return error;
}

function errorRecord(value: Error): RemoteRequestError {
  return value;
}

export function vectorizeRateLimitInfo(
  error: MemoryDatabaseError,
): VectorizeRateLimitInfo | undefined {
  const seen = new Set<Error>();
  let current: Error | undefined = error;
  let rateLimited = false;
  let retryAfterMs: number | undefined;
  while (current && !seen.has(current)) {
    seen.add(current);
    const candidate = errorRecord(current);
    if (!candidate) {
      break;
    }
    const message = candidate.message;
    const status = candidate.status;
    const isRateLimited =
      status === 429 ||
      /(?:too many requests|rate[ -]?limit|\b429\b|\b40041\b)/i.test(message);
    if (isRateLimited) {
      rateLimited = true;
      if (
        retryAfterMs === undefined &&
        candidate.retryAfterMs !== undefined &&
        Number.isFinite(candidate.retryAfterMs)
      ) {
        retryAfterMs = candidate.retryAfterMs;
      }
    }
    current = candidate.cause instanceof Error ? candidate.cause : undefined;
  }
  return rateLimited ? { retryAfterMs } : undefined;
}

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

function asRecord(value: JsonValue): JsonObject {
  const object = jsonObject(value);
  if (object === undefined) {
    throw new Error("Remote vector API returned an invalid response.");
  }
  return object;
}

function parseMutation(value: JsonValue): MemoryVectorMutation {
  const result = asRecord(value);
  const id = jsonString(result.id);
  const mutationId = jsonString(result.mutationId);
  if (id === undefined || mutationId === undefined) {
    throw new Error("Remote vector API returned an invalid mutation.");
  }
  return {
    id,
    namespace: jsonString(result.namespace),
    mutationId,
  };
}

function parseSearchResult(value: JsonValue): MemoryVectorSearchResult {
  const result = asRecord(value);
  if (!Array.isArray(result.matches)) {
    throw new Error("Remote vector API returned an invalid search result.");
  }
  const matches = result.matches.map((match, index): MemoryVectorMatch => {
    const candidate = asRecord(match);
    const id = jsonString(candidate.id);
    const score = jsonNumber(candidate.score);
    if (id === undefined || id.trim().length === 0 || score === undefined) {
      throw new Error(
        `Remote vector API returned an invalid search match at index ${index}.`,
      );
    }
    const metadata = candidate.metadata;
    return {
      id,
      score,
      metadata: jsonObject(metadata) ?? {},
    };
  });
  return {
    count: jsonNumber(result.count) ?? matches.length,
    matches,
  };
}

type RequestOptions<T> = {
  readonly queryUrl: string;
  readonly token: string | undefined;
  readonly operation: string;
  readonly path: string;
  readonly body: JsonValue;
  readonly parse: (value: JsonValue) => T;
  readonly beforeRequest?: () => Promise<void>;
};

function request<T>(
  options: RequestOptions<T>,
): Effect.Effect<T, MemoryDatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      await options.beforeRequest?.();
      const headers: RequestHeaders = { "content-type": "application/json" };
      if (options.token) {
        headers.authorization = `Bearer ${options.token}`;
      }
      const response = await fetch(vectorUrl(options.queryUrl, options.path), {
        method: "POST",
        headers,
        body: JSON.stringify(options.body),
      });
      const payload = await readRemoteResponse(response);
      if (!response.ok || payload.ok !== true) {
        const message =
          jsonString(payload.error) ??
          `Remote vector API returned HTTP ${response.status}.`;
        throw remoteRequestError(response, message);
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
    upsert: (document) =>
      request({
        queryUrl,
        token,
        operation: "vectorize/upsert",
        path: "/vectorize/upsert",
        body: document,
        parse: parseMutation,
        beforeRequest: () =>
          validateBgeEmbeddingText(
            memoryVectorEmbeddingText(document),
            "Memory",
          ),
      }),
    delete: (id) =>
      request({
        queryUrl,
        token,
        operation: "vectorize/delete",
        path: "/vectorize/delete",
        body: { id },
        parse: parseMutation,
      }),
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

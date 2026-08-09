import { Effect } from "effect";
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

export type MemoryVectorMutation = {
  readonly id: string;
  readonly namespace?: string;
  readonly mutationId: string;
};

export type MemoryVectorMatch = {
  readonly id: string;
  readonly score: number;
  readonly metadata: Record<string, unknown>;
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

type RemoteVectorResponse = {
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
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

function errorRecord(value: unknown):
  | {
      readonly message?: unknown;
      readonly status?: unknown;
      readonly retryAfterMs?: unknown;
      readonly cause?: unknown;
    }
  | undefined {
  return value && typeof value === "object"
    ? (value as {
        readonly message?: unknown;
        readonly status?: unknown;
        readonly retryAfterMs?: unknown;
        readonly cause?: unknown;
      })
    : undefined;
}

export function vectorizeRateLimitInfo(
  error: MemoryDatabaseError,
): VectorizeRateLimitInfo | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let rateLimited = false;
  let retryAfterMs: number | undefined;
  while (current && !seen.has(current)) {
    seen.add(current);
    const candidate = errorRecord(current);
    if (!candidate) {
      break;
    }
    const message =
      typeof candidate.message === "string" ? candidate.message : "";
    const status = candidate.status;
    const isRateLimited =
      status === 429 ||
      /(?:too many requests|rate[ -]?limit|\b429\b|\b40041\b)/i.test(
        message,
      );
    if (isRateLimited) {
      rateLimited = true;
      if (
        retryAfterMs === undefined &&
        typeof candidate.retryAfterMs === "number" &&
        Number.isFinite(candidate.retryAfterMs)
      ) {
        retryAfterMs = candidate.retryAfterMs;
      }
    }
    current = candidate.cause;
  }
  return rateLimited ? { retryAfterMs } : undefined;
}

async function readRemoteResponse(
  response: Response,
): Promise<RemoteVectorResponse> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("response was not a JSON object");
    }
    return parsed as RemoteVectorResponse;
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

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Remote vector API returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function parseMutation(value: unknown): MemoryVectorMutation {
  const result = asRecord(value);
  if (typeof result.id !== "string" || typeof result.mutationId !== "string") {
    throw new Error("Remote vector API returned an invalid mutation.");
  }
  return {
    id: result.id,
    namespace:
      typeof result.namespace === "string" ? result.namespace : undefined,
    mutationId: result.mutationId,
  };
}

function parseSearchResult(value: unknown): MemoryVectorSearchResult {
  const result = asRecord(value);
  if (!Array.isArray(result.matches)) {
    throw new Error("Remote vector API returned an invalid search result.");
  }
  const matches = result.matches.map((match, index): MemoryVectorMatch => {
    const candidate = asRecord(match);
    if (
      typeof candidate.id !== "string" ||
      candidate.id.trim().length === 0 ||
      typeof candidate.score !== "number" ||
      !Number.isFinite(candidate.score)
    ) {
      throw new Error(
        `Remote vector API returned an invalid search match at index ${index}.`,
      );
    }
    const metadata = candidate.metadata;
    return {
      id: candidate.id,
      score: candidate.score,
      metadata:
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>)
          : {},
    };
  });
  return {
    count: typeof result.count === "number" ? result.count : matches.length,
    matches,
  };
}

type RequestOptions<T> = {
  readonly queryUrl: string;
  readonly token: string | undefined;
  readonly operation: string;
  readonly path: string;
  readonly body: unknown;
  readonly parse: (value: unknown) => T;
};

function request<T>(
  options: RequestOptions<T>,
): Effect.Effect<T, MemoryDatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
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
          typeof payload.error === "string"
            ? payload.error
            : `Remote vector API returned HTTP ${response.status}.`;
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

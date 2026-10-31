import {
  decodeResponse,
  ErrorBodySchema,
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
import { MemoryDatabaseError } from "./errors";

type RequestHeaders = {
  "content-type": string;
  authorization?: string;
};

export type PostJsonOptions<T> = {
  readonly url: string;
  readonly token: string | undefined;
  readonly body: unknown;
  /** MemoryDatabaseError operation for every failure of this request. */
  readonly operation: string;
  /** Message subject, e.g. "Remote database". */
  readonly service: string;
  /** Message used when the failure cause is not an Error. */
  readonly fallbackMessage: string;
  /** decodeResponse label for the error body. */
  readonly errorLabel: string;
  /**
   * When set, a JSON body that is not an object fails with this message and
   * the non-JSON message omits the content type.
   */
  readonly invalidObjectMessage?: string;
  /** Maps a successful (`ok: true`) payload; thrown errors become MemoryDatabaseError. */
  readonly parse: (payload: JsonObject) => T;
};

/** Resolves an API path relative to the configured `/query` endpoint URL. */
export function apiUrl(queryUrl: string, path: string): string {
  const parsed = new URL(queryUrl);
  const basePath = parsed.pathname.replace(/\/query\/?$/, "");
  parsed.pathname = `${basePath}${path}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function toContractValue(value: JsonValue): ContractJsonValue {
  // SAFETY: parsed JSON response values carry no undefined entries.
  return value as ContractJsonValue;
}

async function readPayload<T>(
  response: Response,
  options: PostJsonOptions<T>,
): Promise<JsonObject> {
  const text = await response.text();
  if (options.invalidObjectMessage !== undefined) {
    let parsed: JsonValue;
    try {
      parsed = parseJson(text);
    } catch (cause) {
      throw new Error(
        `${options.service} returned non-JSON HTTP ${response.status}.`,
        { cause },
      );
    }
    const payload = jsonObject(parsed);
    if (payload === undefined) {
      throw new Error(options.invalidObjectMessage);
    }
    return payload;
  }
  try {
    const payload = jsonObject(parseJson(text));
    if (payload === undefined) {
      throw new Error("response was not a JSON object");
    }
    return payload;
  } catch (cause) {
    const contentType = response.headers.get("content-type") ?? "unknown";
    throw new Error(
      `${options.service} returned non-JSON HTTP ${response.status} (${contentType}).`,
      { cause },
    );
  }
}

/** Bearer-authenticated JSON POST to the remote API; the CLI's only remote API HTTP client. */
export function postJson<T>(
  options: PostJsonOptions<T>,
): Effect.Effect<T, MemoryDatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      const headers: RequestHeaders = { "content-type": "application/json" };
      if (options.token) {
        headers.authorization = `Bearer ${options.token}`;
      }
      // Remote API HTTP boundary; errors are typed by tryPromise's catch.
      // @effect-diagnostics-next-line globalFetchInEffect:off
      const response = await fetch(options.url, {
        method: "POST",
        headers,
        body: JSON.stringify(options.body),
      });
      const payload = await readPayload(response, options);
      if (!response.ok || payload.ok !== true) {
        const failure = decodeResponse(
          ErrorBodySchema,
          toContractValue(payload),
          options.errorLabel,
        );
        const message =
          failure?.error ??
          jsonString(payload.error) ??
          `${options.service} returned HTTP ${response.status}.`;
        throw new Error(message);
      }
      return options.parse(payload);
    },
    catch: (cause) =>
      new MemoryDatabaseError({
        operation: options.operation,
        message:
          cause instanceof Error ? cause.message : options.fallbackMessage,
        cause,
      }),
  });
}

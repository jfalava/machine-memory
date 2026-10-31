import {
  encodeResponse,
  ErrorBodySchema,
  MAX_EMBEDDING_TOKENS,
} from "@machine-memory/contract";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";

/** An expected client error, rendered by `recoverHttpFailure` as `{ ok: false, error }`. */
export class HttpFailure extends Schema.TaggedError<HttpFailure>()(
  "HttpFailure",
  {
    status: Schema.Literals([400, 404, 409]),
    error: Schema.String,
  },
) {}

export const badRequest = (error: string) =>
  Effect.fail(new HttpFailure({ status: 400, error }));

export const notFound = (error: string) =>
  Effect.fail(new HttpFailure({ status: 404, error }));

export const memoryNotFound = (id: number, repository: string) =>
  notFound(`No memory found with id ${id} in repository '${repository}'.`);

export const conflict = (error: string) =>
  Effect.fail(new HttpFailure({ status: 409, error }));

export const embeddingBudgetError = (label: "Query" | "Document text") =>
  `${label} must be at most ${MAX_EMBEDDING_TOKENS} tokens for embedding.`;

export const recoverHttpFailure = <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(Schema.is(HttpFailure), (failure) =>
      HttpServerResponse.json(
        encodeResponse(ErrorBodySchema, { ok: false, error: failure.error }),
        { status: failure.status },
      ),
    ),
  );

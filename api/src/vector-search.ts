import {
  decodeRequest,
  embeddingSizeReport,
  encodeResponse,
  normalizeVectorizeSearchRequest,
  VectorizeSearchRequestInputSchema,
  VectorizeSearchResultSchema,
  VectorizeSearchSuccessSchema,
  type JsonValue,
} from "@machine-memory/contract";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";

import type { ApiContext } from "./api-context";
import { badRequest, embeddingBudgetError } from "./http-failure";
import { vectorFilter, type ProductFilters } from "./product-api";

/** Embeds the query and searches the repository namespace in Vectorize. */
export const searchVectors = (
  ctx: ApiContext,
  query: string,
  repository: string,
  topK: number,
  filters: ProductFilters,
) =>
  Effect.gen(function* () {
    const values = yield* ctx.embed(query);
    const filter = vectorFilter(filters);
    const options = {
      namespace: repository,
      topK,
      returnMetadata: "all" as const,
    };
    if (Object.keys(filter).length > 0) {
      Object.assign(options, { filter });
    }
    const matches = yield* ctx.vectorize.query(values, options);
    // A malformed Vectorize response stays a defect, as the sync decode was.
    return yield* Schema.decodeEffect(VectorizeSearchResultSchema)(
      matches,
    ).pipe(Effect.orDie);
  });

/** POST /vectorize/search */
export const handleVectorizeSearch = (ctx: ApiContext, body: JsonValue) =>
  Effect.gen(function* () {
    const input = decodeRequest(VectorizeSearchRequestInputSchema, body);
    if (!input.ok) {
      return yield* badRequest(input.error);
    }
    const request = normalizeVectorizeSearchRequest(input.value);
    if (!embeddingSizeReport(request.query).within_budget) {
      return yield* badRequest(embeddingBudgetError("Query"));
    }
    const result = yield* searchVectors(
      ctx,
      request.query,
      request.repository,
      request.top_k,
      request,
    );
    return yield* HttpServerResponse.json(
      encodeResponse(VectorizeSearchSuccessSchema, { ok: true, result }),
    );
  });

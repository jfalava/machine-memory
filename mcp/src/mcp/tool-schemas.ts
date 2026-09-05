import {
  PRODUCT_OPERATIONS,
  type ProductRequest,
} from "@machine-memory/contract";
import { mcpInputSchema } from "./schema-bridge";

export type ListRepositoriesArgs = ProductRequest<"list-repositories">;
export const listRepositoriesInput = mcpInputSchema(
  PRODUCT_OPERATIONS["list-repositories"].request,
);

export type MemoryQueryArgs = ProductRequest<"query">;
export const memoryQueryInput = mcpInputSchema(
  PRODUCT_OPERATIONS["query"].request,
);

export type MemoryGetArgs = ProductRequest<"get">;
export const memoryGetInput = mcpInputSchema(PRODUCT_OPERATIONS["get"].request);

export type MemoryListArgs = ProductRequest<"list">;
export const memoryListInput = mcpInputSchema(
  PRODUCT_OPERATIONS["list"].request,
);

export type MemorySuggestArgs = ProductRequest<"suggest">;
export const memorySuggestInput = mcpInputSchema(
  PRODUCT_OPERATIONS["suggest"].request,
);

export type MemoryVerifyArgs = ProductRequest<"verify">;
export const memoryVerifyInput = mcpInputSchema(
  PRODUCT_OPERATIONS["verify"].request,
);

export type MemoryDiffArgs = ProductRequest<"diff">;
export const memoryDiffInput = mcpInputSchema(
  PRODUCT_OPERATIONS["diff"].request,
);

export type MemoryAddArgs = ProductRequest<"add">;
export const memoryAddInput = mcpInputSchema(PRODUCT_OPERATIONS["add"].request);

export type MemoryUpdateArgs = ProductRequest<"update">;
export const memoryUpdateInput = mcpInputSchema(
  PRODUCT_OPERATIONS["update"].request,
);

export type MemorySizeArgs = ProductRequest<"size">;
export const memorySizeInput = mcpInputSchema(
  PRODUCT_OPERATIONS["size"].request,
);

export type MemoryDeleteArgs = ProductRequest<"delete">;
export const memoryDeleteInput = mcpInputSchema(
  PRODUCT_OPERATIONS["delete"].request,
);

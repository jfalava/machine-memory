import {
  MemoryQueryArgsInputSchema,
  MemoryGetArgsSchema,
  MemoryListArgsInputSchema,
  MemorySuggestArgsInputSchema,
  MemoryAddArgsInputSchema,
  MemoryUpdateArgsSchema,
  MemoryDeleteArgsSchema,
  MemoryDeleteManyArgsSchema,
  MemoryDeprecateArgsSchema,
  MemoryDoctorArgsSchema,
  MemoryStatsArgsSchema,
  MemoryGcArgsSchema,
  MemoryVerifyArgsSchema,
  MemoryDiffArgsSchema,
  MemorySizeArgsInputSchema,
  ListRepositoriesArgsInputSchema,
} from "./ops";
import {
  MemoryQuerySuccessSchema,
  MemoryGetSuccessSchema,
  MemoryListSuccessSchema,
  MemorySuggestSuccessSchema,
  MemoryWriteSuccessSchema,
  MemoryDeleteSuccessSchema,
  MemoryDeleteManySuccessSchema,
  MemoryDeprecateSuccessSchema,
  MemoryDoctorSuccessSchema,
  MemoryStatsSuccessSchema,
  MemoryGcSuccessSchema,
  MemoryVerifySuccessSchema,
  MemoryDiffSuccessSchema,
  MemorySizeSuccessSchema,
  ListRepositoriesSuccessSchema,
} from "./results";

/** One catalog for product route names and both sides of their wire contract. */
export const PRODUCT_OPERATIONS = {
  query: {
    request: MemoryQueryArgsInputSchema,
    response: MemoryQuerySuccessSchema,
  },
  get: { request: MemoryGetArgsSchema, response: MemoryGetSuccessSchema },
  list: {
    request: MemoryListArgsInputSchema,
    response: MemoryListSuccessSchema,
  },
  suggest: {
    request: MemorySuggestArgsInputSchema,
    response: MemorySuggestSuccessSchema,
  },
  add: {
    request: MemoryAddArgsInputSchema,
    response: MemoryWriteSuccessSchema,
  },
  update: {
    request: MemoryUpdateArgsSchema,
    response: MemoryWriteSuccessSchema,
  },
  delete: {
    request: MemoryDeleteArgsSchema,
    response: MemoryDeleteSuccessSchema,
  },
  "delete-many": {
    request: MemoryDeleteManyArgsSchema,
    response: MemoryDeleteManySuccessSchema,
  },
  deprecate: {
    request: MemoryDeprecateArgsSchema,
    response: MemoryDeprecateSuccessSchema,
  },
  doctor: {
    request: MemoryDoctorArgsSchema,
    response: MemoryDoctorSuccessSchema,
  },
  stats: {
    request: MemoryStatsArgsSchema,
    response: MemoryStatsSuccessSchema,
  },
  gc: {
    request: MemoryGcArgsSchema,
    response: MemoryGcSuccessSchema,
  },
  verify: {
    request: MemoryVerifyArgsSchema,
    response: MemoryVerifySuccessSchema,
  },
  diff: { request: MemoryDiffArgsSchema, response: MemoryDiffSuccessSchema },
  size: {
    request: MemorySizeArgsInputSchema,
    response: MemorySizeSuccessSchema,
  },
  "list-repositories": {
    request: ListRepositoriesArgsInputSchema,
    response: ListRepositoriesSuccessSchema,
  },
};
export type ProductRoute = keyof typeof PRODUCT_OPERATIONS;
export type ProductRequest<R extends ProductRoute> =
  (typeof PRODUCT_OPERATIONS)[R]["request"]["Type"];
export type ProductResponse<R extends ProductRoute> =
  (typeof PRODUCT_OPERATIONS)[R]["response"]["Type"];

export function isProductRoute(value: string): value is ProductRoute {
  return Object.hasOwn(PRODUCT_OPERATIONS, value);
}
export const PRODUCT_ROUTES =
  Object.keys(PRODUCT_OPERATIONS).filter(isProductRoute);
export function productRoutePath(route: ProductRoute): string {
  return `/product/${route}`;
}
export function normalizeProductRoute(path: string): ProductRoute | undefined {
  if (!path.startsWith("/product/")) {
    return undefined;
  }
  const route = path.slice("/product/".length);
  return isProductRoute(route) ? route : undefined;
}

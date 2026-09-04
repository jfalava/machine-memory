import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Api from "../api/src/worker";
import { createMcpWorker } from "../mcp/src/worker";
import {
  deployConfig,
  deployDocs,
  deployDomain,
  docsWorkerName,
  routerName,
  stackName,
} from "./src/config";
import { Database, OAuthKv } from "./src/database";
import { createVectorMetadataIndexes, VectorIndex } from "./src/vectorize";

/**
 * Multi-worker stack (manifold pattern):
 * - API: authenticated REST (/query, /migrate, /vectorize/*)
 * - MCP: OAuth + /mcp tools
 * - Docs (optional): static site behind explicit docs mounts on the router
 * - Router: sole public entry (custom domain or workers.dev)
 *
 * Worker sources live in ../api, ../mcp, ../router. This package owns IaC only.
 */
export default Alchemy.Stack(
  stackName,
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const database = yield* Database;
    const vectorIndex = yield* VectorIndex;
    const oauthKv = yield* OAuthKv;
    const metadataIndexes = createVectorMetadataIndexes(vectorIndex.indexName);
    yield* metadataIndexes.status;
    yield* metadataIndexes.memoryType;
    yield* metadataIndexes.certainty;

    const api = yield* Api;
    const mcp = yield* createMcpWorker(api);

    const docsWorker = deployDocs
      ? yield* Cloudflare.Website.StaticSite("machine-memory-docs", {
          name: docsWorkerName,
          cwd: "../docs",
          command: "bash ./scripts/build-cf.sh",
          outdir: "dist",
          main: "./src/docs-worker.ts",
          workersDev: false,
          assets: {
            notFoundHandling: "404-page",
            runWorkerFirst: true,
          },
        })
      : undefined;

    const routerEnvBase = {
      API: api,
      MCP: mcp,
    };
    const routerEnv =
      docsWorker === undefined
        ? routerEnvBase
        : { ...routerEnvBase, DOCS_WORKER: docsWorker };

    const routerBase = {
      name: routerName,
      main: "../router/src/index.ts",
      workersDev: deployDomain === undefined,
      env: routerEnv,
    };
    const routerProps =
      deployDomain === undefined
        ? routerBase
        : { ...routerBase, domain: deployDomain };

    const router = yield* Cloudflare.Worker(
      "machine-memory-router",
      routerProps,
    );

    return {
      url: router.url.as<string>(),
      routerUrl: router.url.as<string>(),
      databaseName: database.databaseName,
      vectorIndexName: vectorIndex.indexName.as<string>(),
      oauthKvName: oauthKv.title,
      docs: deployDocs,
      domain: deployDomain ?? null,
      workers: deployConfig.workers,
    };
  }),
);

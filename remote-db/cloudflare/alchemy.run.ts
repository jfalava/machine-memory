import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Api from "./src/worker";
import Mcp from "./src/mcp-worker";
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
 * - Docs (optional): static site behind the router catch-all
 * - Router: sole public entry (custom domain or workers.dev)
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
    const mcp = yield* Mcp;

    const docsWorker = deployDocs
      ? yield* Cloudflare.Website.StaticSite("machine-memory-docs", {
          name: docsWorkerName,
          // monorepo: stack lives at remote-db/cloudflare; docs at docs/
          cwd: "../../docs",
          command: "bun run build",
          outdir: "dist",
          // main is relative to the Alchemy stack package (this directory)
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
      main: "./src/router-worker.ts",
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

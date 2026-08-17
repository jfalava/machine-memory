import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Api from "./src/worker";
import { Database, OAuthKv } from "./src/database";
import { stackName } from "./src/config";
import { createVectorMetadataIndexes, VectorIndex } from "./src/vectorize";

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

    return {
      url: api.url.as<string>(),
      databaseName: database.databaseName,
      vectorIndexName: vectorIndex.indexName.as<string>(),
      oauthKvName: oauthKv.title,
    };
  }),
);

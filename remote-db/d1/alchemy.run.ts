import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Api from "./src/worker";
import { Database } from "./src/database";
import { stackName } from "./src/config";

export default Alchemy.Stack(
  stackName,
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const database = yield* Database;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
      databaseName: database.databaseName,
    };
  }),
);

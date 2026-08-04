import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Api from "./src/machine-memory-api";
import { Database } from "./src/database";

export default Alchemy.Stack(
  "machine-memory-remote-datbase",
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

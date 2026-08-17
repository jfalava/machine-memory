import * as Cloudflare from "alchemy/Cloudflare";
import { databaseName, oauthKvName } from "./config";

/**
 * The D1 database backing the machine-memory remote adapter.
 * Alchemy applies numbered SQL files under `migrations` during deployment.
 */
export const Database = Cloudflare.D1.Database("machine-memory-db", {
  name: databaseName,
  migrationsDir: "./migrations",
});

/**
 * The KV namespace storing OAuth 2.1 authorization state, tokens, and
 * registered clients for the MCP endpoint.
 */
export const OAuthKv = Cloudflare.KV.Namespace("machine-memory-oauth-kv", {
  title: oauthKvName,
});

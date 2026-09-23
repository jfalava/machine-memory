import * as Cloudflare from "alchemy/Cloudflare";

import { databaseName, oauthKvName } from "./config";

/**
 * The D1 database backing the machine-memory remote adapter.
 * Alchemy applies numbered SQL files under `migrations` during deployment.
 */
export const Database = Cloudflare.D1.Database("machine-memory-db", {
  name: databaseName,
  migrations: "./migrations",
});

/**
 * The KV namespace storing OAuth 2.1 authorization state, tokens, and
 * registered clients for the MCP endpoint.
 */
export const OAuthKv = Cloudflare.KV.Namespace("machine-memory-oauth-kv", {
  title: oauthKvName,
});

/** Atomic, short-lived headless approvals; separate from project memory data. */
export const OAuthDevices = Cloudflare.D1.Database(
  "machine-memory-oauth-devices",
  {
    name: `${oauthKvName}-devices`,
    migrations: "./oauth-migrations",
  },
);

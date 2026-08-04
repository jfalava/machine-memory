import * as Cloudflare from "alchemy/Cloudflare";
import { databaseName } from "./config";

/**
 * The D1 database backing the machine-memory remote adapter.
 * Alchemy applies numbered SQL files under `migrations` during deployment.
 */
export const Database = Cloudflare.D1.Database("machine-memory-db", {
  name: databaseName,
  migrationsDir: "./migrations",
});

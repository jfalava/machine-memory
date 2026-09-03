import { loadDeployConfig } from "./deploy-config";

/**
 * Resolved once at module load for Alchemy stack import.
 * Prefer env (CLI injects via deployConfigToEnv). When running `alchemy deploy`
 * from remote-db/cloudflare with a sibling machine-memory.deploy.json, that file
 * is discovered from cwd.
 */
export const deployConfig = loadDeployConfig();

export const stackName = deployConfig.stackName;
export const databaseName = deployConfig.databaseName;
export const apiName = deployConfig.workers.api;
export const mcpName = deployConfig.workers.mcp;
export const routerName = deployConfig.workers.router;
export const docsWorkerName = deployConfig.workers.docs;
export const vectorIndexName = deployConfig.vectorIndexName;
export const oauthKvName = deployConfig.oauthKvName;
export const deployDomain = deployConfig.domain;
export const deployDocs = deployConfig.docs;

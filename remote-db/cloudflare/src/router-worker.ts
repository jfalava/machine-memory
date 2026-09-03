/**
 * Edge router entry. Alchemy wires API / MCP / optional DOCS_WORKER service
 * bindings and the public domain in alchemy.run.ts; this module only exports
 * the Hono app for bundling.
 */
export { default, app, type Env } from "./router/index";

import { decodeResponse, StatusSuccessSchema } from "@machine-memory/contract";
import { Effect } from "effect";

import { VERSION } from "../../constants";
import { loadDatabaseConfig } from "../../database-config";
import { commandError } from "../../effect/errors";
import { apiUrl, toContractValue } from "../../effect/remote-http";
import { parseJson, type JsonObject } from "../../json";
import type { CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";

/** No /status route: 404 from the API Worker, 418 from the router in front of it. */
const ROUTE_MISSING = new Set([404, 418]);

/** Why the Worker gave no status, as the next step that fixes it. */
function failureNote(status: number): string {
  if (status === 401) {
    return "The Worker refused the token. Run 'machine-memory remote setup' with the Worker's current token.";
  }
  if (ROUTE_MISSING.has(status)) {
    return "This deployment has no /status route, so it runs an older release than this CLI. Deploy the current stack; until then its version and schema cannot be read.";
  }
  return `The Worker answered /status with HTTP ${status}.`;
}

function mismatchNote(worker: {
  version: string;
  schema_level: number;
  schema_expected: number;
}): string | undefined {
  if (worker.schema_level !== worker.schema_expected) {
    return `The database has applied ${worker.schema_level} of the ${worker.schema_expected} migrations the Worker expects. Deploy again so the migrations run.`;
  }
  if (worker.version !== VERSION) {
    return `The Worker runs ${worker.version} and this CLI is ${VERSION}. Deploy the Worker or install the matching CLI; commands can fail on requests one side does not know.`;
  }
  return undefined;
}

async function workerStatus(url: string, token: string | undefined) {
  const base: JsonObject = { cli_version: VERSION, worker_url: url };
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== undefined) {
    headers.set("authorization", `Bearer ${token}`);
  }
  let response: Response;
  try {
    response = await fetch(apiUrl(url, "/status"), {
      method: "POST",
      headers,
      body: "{}",
    });
  } catch (cause) {
    return {
      ...base,
      ok: false,
      reachable: false,
      note: `The Worker could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (!response.ok) {
    return {
      ...base,
      ok: false,
      reachable: true,
      authenticated: ROUTE_MISSING.has(response.status)
        ? null
        : response.status !== 401,
      note: failureNote(response.status),
    };
  }
  const decoded = decodeResponse(
    StatusSuccessSchema,
    toContractValue(parseJson(await response.text())),
    "remote/status",
  );
  if (decoded === undefined) {
    return {
      ...base,
      ok: false,
      reachable: true,
      note: "The Worker's /status response was not understood.",
    };
  }
  const worker = decoded.result;
  const report: JsonObject = {
    ...base,
    ok: true,
    reachable: true,
    authenticated: true,
    worker_version: worker.version,
    versions_match: worker.version === VERSION,
    schema_level: worker.schema_level,
    schema_expected: worker.schema_expected,
  };
  const note = mismatchNote(worker);
  if (note !== undefined) {
    report.note = note;
  }
  return report;
}

/** Reports what the configured Worker runs next to this CLI, so a mismatch names itself. */
export function remoteStatus(context: CommandContext) {
  return Effect.gen(function* () {
    const remote = yield* Effect.tryPromise({
      try: () =>
        loadDatabaseConfig(process.env, { local: false, remote: true }),
      catch: (cause) =>
        commandError(
          "remote status",
          cause instanceof Error
            ? cause.message
            : "Could not load remote credentials.",
          cause,
          "machine-memory remote setup",
        ),
    });
    if (remote.kind !== "remote") {
      return yield* commandError(
        "remote status",
        "No remote Worker is configured.",
        undefined,
        "machine-memory remote setup",
      );
    }
    const status = yield* Effect.promise(() =>
      workerStatus(remote.url, remote.token),
    );
    yield* Effect.sync(() => {
      if (status.ok !== true) {
        process.exitCode = 1;
      }
      printCommandOutput(context, status);
    });
  });
}

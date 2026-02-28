import { Database } from "bun:sqlite";
import { printJson } from "./lib/cli";
import { VERSION } from "./lib/constants";
import { ensureDb } from "./lib/db";
import { helpPayload } from "./lib/cli/help";
import { parseOutputMode, parseSqliteErrorDetails } from "./lib/cli/shared";
import { upgrade } from "./lib/upgrade";
import { handleTagMapCommand } from "./lib/cli/commands/tag-map";
import {
  handleAddCommand,
  handleDeleteCommand,
  handleDeprecateCommand,
  handleUpdateCommand,
} from "./lib/cli/commands/memory-write";
import {
  handleDiffCommand,
  handleGetCommand,
  handleListCommand,
  handleQueryCommand,
  handleSuggestCommand,
  handleVerifyCommand,
} from "./lib/cli/commands/memory-read";
import {
  handleCoverageCommand,
  handleExportCommand,
  handleGcCommand,
  handleImportCommand,
  handleMigrateCommand,
  handleStatsCommand,
} from "./lib/cli/commands/maintenance";

const [command, ...args] = process.argv.slice(2);

if (
  !command ||
  command === "help" ||
  command === "--help" ||
  command === "-h"
) {
  printJson(helpPayload());
  process.exit(!command ? 1 : 0);
}

if (command === "version") {
  printJson({ version: VERSION });
  process.exit(0);
}
if (command === "upgrade") {
  await upgrade();
  process.exit(0);
}

const dbCommands = new Set([
  "add",
  "query",
  "list",
  "get",
  "update",
  "deprecate",
  "delete",
  "suggest",
  "verify",
  "diff",
  "coverage",
  "gc",
  "stats",
  "import",
  "export",
  "migrate",
]);
const writeCommands = new Set([
  "add",
  "update",
  "deprecate",
  "delete",
  "import",
  "migrate",
]);
const outputMode = parseOutputMode(args);

let memoryDb: Database | null = null;
if (dbCommands.has(command)) {
  try {
    memoryDb = ensureDb(writeCommands.has(command) ? "write" : "read");
  } catch (err) {
    printJson({
      error:
        err instanceof Error
          ? err.message
          : "Unable to open machine-memory database.",
    });
    process.exit(1);
  }
}

function requireDb(): Database {
  if (!memoryDb) {
    throw new Error("Database is not initialized for this command.");
  }
  return memoryDb;
}

const commandContext = {
  args,
  outputMode,
  requireDb,
};

try {
  switch (command) {
    case "tag-map": {
      handleTagMapCommand(args);
      break;
    }
    case "add": {
      handleAddCommand(commandContext);
      break;
    }
    case "query": {
      handleQueryCommand(commandContext);
      break;
    }
    case "get": {
      handleGetCommand(commandContext);
      break;
    }
    case "update": {
      handleUpdateCommand(commandContext);
      break;
    }
    case "deprecate": {
      handleDeprecateCommand(commandContext);
      break;
    }
    case "delete": {
      handleDeleteCommand(commandContext);
      break;
    }
    case "list": {
      handleListCommand(commandContext);
      break;
    }
    case "suggest": {
      handleSuggestCommand(commandContext);
      break;
    }
    case "verify": {
      handleVerifyCommand(commandContext);
      break;
    }
    case "diff": {
      handleDiffCommand(commandContext);
      break;
    }
    case "coverage": {
      handleCoverageCommand(commandContext);
      break;
    }
    case "gc": {
      handleGcCommand(commandContext);
      break;
    }
    case "stats": {
      handleStatsCommand(commandContext);
      break;
    }
    case "import": {
      handleImportCommand(commandContext);
      break;
    }
    case "export": {
      handleExportCommand(commandContext);
      break;
    }
    case "migrate": {
      handleMigrateCommand();
      break;
    }
    default:
      printJson({
        error: `Unknown command: ${command}. Run 'machine-memory help' for usage.`,
      });
      process.exit(1);
  }
} catch (err) {
  const details = parseSqliteErrorDetails(err);
  const payload: Record<string, unknown> = {
    error: details.message,
    command,
  };
  if (details.hint) {
    payload.hint = details.hint;
  }
  if (err instanceof Error) {
    payload.details = err.message;
  }
  printJson(payload);
  process.exit(1);
} finally {
  if (memoryDb) {
    memoryDb.close();
  }
}

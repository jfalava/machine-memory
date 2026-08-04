import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { handleDoctorCommand } from "./doctor";
import { handleCoverageCommand } from "./coverage";
import { handleExportCommand } from "./export";
import { handleGcCommand } from "./gc";
import { handleImportCommand, handleStatsCommand } from "./maintenance";
import {
  handleListCommand,
  handleQueryCommand,
  handleSuggestCommand,
  handleSweepCommand,
} from "./memory-read";
import {
  handleAddCommand,
  handleDeprecateCommand,
  handleUpdateCommand,
} from "./memory-write";
import { handleTagMapCommand } from "./tag-map";
import { handleUpdateAgentsMdCommand } from "./update-agents-md";
import { handleDiffCommand } from "./diff";
import { handleMigrateCommand } from "./migrate";
import { handleVerifyCommand } from "./verify";
import { handleDeleteCommand } from "./delete";
import { handleGetCommand } from "./get";
import { VERSION } from "../../constants";
import { printJson } from "../../cli-utils";
import { upgrade } from "../../upgrade";
import { helpPayload } from "../help";
import {
  booleanFlag,
  booleanSpec,
  effectCommand,
  outputConfig,
  outputSpecs,
  positionalArgs,
  stringFlag,
  stringSpec,
} from "../runtime/command";

const addCommand = effectCommand(
  "add",
  {
    args: positionalArgs(),
    "from-file": stringFlag("from-file"),
    "upsert-match": stringFlag("upsert-match"),
    path: stringFlag("path"),
    tags: stringFlag("tags"),
    context: stringFlag("context"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    "source-agent": stringFlag("source-agent"),
    refs: stringFlag("refs"),
    "expires-after-days": stringFlag("expires-after-days"),
    "no-conflicts": booleanFlag("no-conflicts"),
    ...outputConfig(),
  },
  [
    stringSpec("from-file"),
    stringSpec("upsert-match"),
    stringSpec("path"),
    stringSpec("tags"),
    stringSpec("context"),
    stringSpec("type"),
    stringSpec("certainty"),
    stringSpec("source-agent"),
    stringSpec("refs"),
    stringSpec("expires-after-days"),
    booleanSpec("no-conflicts"),
    ...outputSpecs,
  ],
  "write",
  handleAddCommand,
);

const queryCommand = effectCommand(
  "query",
  {
    args: positionalArgs(),
    tags: stringFlag("tags"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    "include-deprecated": booleanFlag("include-deprecated"),
    limit: stringFlag("limit"),
    "explain-score": booleanFlag("explain-score"),
    ...outputConfig(),
  },
  [
    stringSpec("tags"),
    stringSpec("type"),
    stringSpec("certainty"),
    booleanSpec("include-deprecated"),
    stringSpec("limit"),
    booleanSpec("explain-score"),
    ...outputSpecs,
  ],
  "read",
  handleQueryCommand,
);

const listCommand = effectCommand(
  "list",
  {
    args: positionalArgs(),
    tags: stringFlag("tags"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    status: stringFlag("status"),
    "include-deprecated": booleanFlag("include-deprecated"),
    limit: stringFlag("limit"),
    ...outputConfig(),
  },
  [
    stringSpec("tags"),
    stringSpec("type"),
    stringSpec("certainty"),
    stringSpec("status"),
    booleanSpec("include-deprecated"),
    stringSpec("limit"),
    ...outputSpecs,
  ],
  "read",
  handleListCommand,
);

const getCommand = effectCommand(
  "get",
  { args: positionalArgs() },
  [],
  "read",
  handleGetCommand,
);
const updateCommand = effectCommand(
  "update",
  {
    args: positionalArgs(),
    match: stringFlag("match"),
    "from-file": stringFlag("from-file"),
    tags: stringFlag("tags"),
    context: stringFlag("context"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    "updated-by": stringFlag("updated-by"),
    refs: stringFlag("refs"),
    "expires-after-days": stringFlag("expires-after-days"),
  },
  [
    stringSpec("match"),
    stringSpec("from-file"),
    stringSpec("tags"),
    stringSpec("context"),
    stringSpec("type"),
    stringSpec("certainty"),
    stringSpec("updated-by"),
    stringSpec("refs"),
    stringSpec("expires-after-days"),
  ],
  "write",
  handleUpdateCommand,
);
const deprecateCommand = effectCommand(
  "deprecate",
  {
    args: positionalArgs(),
    match: stringFlag("match"),
    "superseded-by": stringFlag("superseded-by"),
    "updated-by": stringFlag("updated-by"),
  },
  [stringSpec("match"), stringSpec("superseded-by"), stringSpec("updated-by")],
  "write",
  handleDeprecateCommand,
);
const deleteCommand = effectCommand(
  "delete",
  { args: positionalArgs() },
  [],
  "write",
  handleDeleteCommand,
);

const suggestCommand = effectCommand(
  "suggest",
  {
    args: positionalArgs(),
    files: stringFlag("files"),
    "files-json": stringFlag("files-json"),
    tags: stringFlag("tags"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    "include-deprecated": booleanFlag("include-deprecated"),
    limit: stringFlag("limit"),
    "explain-score": booleanFlag("explain-score"),
    ...outputConfig(),
  },
  [
    stringSpec("files"),
    stringSpec("files-json"),
    stringSpec("tags"),
    stringSpec("type"),
    stringSpec("certainty"),
    booleanSpec("include-deprecated"),
    stringSpec("limit"),
    booleanSpec("explain-score"),
    ...outputSpecs,
  ],
  "read",
  handleSuggestCommand,
);
const sweepCommand = effectCommand(
  "sweep",
  {
    args: positionalArgs(),
    files: stringFlag("files"),
    "files-json": stringFlag("files-json"),
    query: stringFlag("query"),
    tags: stringFlag("tags"),
    limit: stringFlag("limit"),
    ...outputConfig(),
  },
  [
    stringSpec("files"),
    stringSpec("files-json"),
    stringSpec("query"),
    stringSpec("tags"),
    stringSpec("limit"),
    ...outputSpecs,
  ],
  "read",
  handleSweepCommand,
);

const doctorCommand = effectCommand(
  "doctor",
  outputConfig(),
  outputSpecs,
  "read",
  handleDoctorCommand,
);
const verifyCommand = effectCommand(
  "verify",
  { args: positionalArgs() },
  [],
  "read",
  handleVerifyCommand,
);
const diffCommand = effectCommand(
  "diff",
  { args: positionalArgs() },
  [],
  "read",
  handleDiffCommand,
);
const coverageCommand = effectCommand(
  "coverage",
  { args: positionalArgs(), root: stringFlag("root") },
  [stringSpec("root")],
  "read",
  handleCoverageCommand,
);
const gcCommand = effectCommand(
  "gc",
  { args: positionalArgs(), "dry-run": booleanFlag("dry-run") },
  [booleanSpec("dry-run")],
  "read",
  handleGcCommand,
);
const statsCommand = effectCommand("stats", {}, [], "read", handleStatsCommand);
const importCommand = effectCommand(
  "import",
  { args: positionalArgs() },
  [],
  "write",
  handleImportCommand,
);
const exportCommand = effectCommand(
  "export",
  {
    args: positionalArgs(),
    tags: stringFlag("tags"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    since: stringFlag("since"),
  },
  [
    stringSpec("tags"),
    stringSpec("type"),
    stringSpec("certainty"),
    stringSpec("since"),
  ],
  "read",
  handleExportCommand,
);
const migrateCommand = effectCommand(
  "migrate",
  {},
  [],
  "write",
  handleMigrateCommand,
);
const tagMapCommand = effectCommand(
  "tag-map",
  { args: positionalArgs() },
  [],
  undefined,
  handleTagMapCommand,
);
const updateAgentsCommand = effectCommand(
  "update-agents-md",
  {},
  [],
  undefined,
  handleUpdateAgentsMdCommand,
);

export const featureCommands = [
  addCommand,
  queryCommand,
  listCommand,
  getCommand,
  updateCommand,
  deprecateCommand,
  deleteCommand,
  suggestCommand,
  sweepCommand,
  doctorCommand,
  verifyCommand,
  diffCommand,
  coverageCommand,
  gcCommand,
  statsCommand,
  importCommand,
  exportCommand,
  migrateCommand,
  tagMapCommand,
  updateAgentsCommand,
] as const;

export function builtinCommands() {
  const helpCommand = Command.make("help", {}, () =>
    Effect.sync(() => printJson(helpPayload())),
  );
  const versionCommand = Command.make("version", {}, () =>
    Effect.sync(() => printJson({ version: VERSION })),
  );
  const upgradeCommand = Command.make("upgrade", {}, () =>
    upgrade().pipe(
      Effect.tap((result) => Effect.sync(() => printJson(result))),
    ),
  );
  return [helpCommand, versionCommand, upgradeCommand] as const;
}

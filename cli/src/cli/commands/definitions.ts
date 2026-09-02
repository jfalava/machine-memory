import { Effect } from "effect";
import { jsonNumber, jsonString, type JsonObject } from "../../json";
import { Command } from "effect/unstable/cli";
import pc from "picocolors";
import { handleDoctorCommand } from "./doctor";
import { handleCoverageCommand } from "./coverage";
import { handleExportCommand } from "./export";
import { handleGcCommand } from "./gc";
import { handleImportCommand, handleStatsCommand } from "./maintenance";
import { handleReindexCommand } from "./reindex";
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
import { handleSizeCommand } from "./size";
import { handleTagMapCommand } from "./tag-map";
import { handleInitCommand } from "./init";
import { handleDiffCommand } from "./diff";
import { handleMigrateCommand } from "./migrate";
import { handleVerifyCommand } from "./verify";
import { handleDeleteCommand } from "./delete";
import { handleGetCommand } from "./get";
import { remoteCommand } from "./remote";
import { localCommand } from "./local";
import { VERSION } from "../../constants";
import {
  upgrade,
  type UpgradeProgress,
  type UpgradeOptions,
} from "../../upgrade";
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
import {
  outputModeForPretty,
  prettyOutput,
  printCommandOutput,
} from "../runtime/output";

const addCommand = effectCommand(
  "add",
  {
    args: positionalArgs(),
    "from-file": stringFlag("from-file"),
    "upsert-match": stringFlag("upsert-match"),
    force: booleanFlag("force"),
    "upsert-threshold": stringFlag("upsert-threshold"),
    "dry-run": booleanFlag("dry-run"),
    path: stringFlag("path"),
    tags: stringFlag("tags"),
    context: stringFlag("context"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    "source-agent": stringFlag("source-agent"),
    refs: stringFlag("refs"),
    "expires-after-days": stringFlag("expires-after-days"),
    "no-conflicts": booleanFlag("no-conflicts"),
    "token-report": booleanFlag("token-report"),
    ...outputConfig(),
  },
  [
    stringSpec("from-file"),
    stringSpec("upsert-match"),
    booleanSpec("force"),
    stringSpec("upsert-threshold"),
    booleanSpec("dry-run"),
    stringSpec("path"),
    stringSpec("tags"),
    stringSpec("context"),
    stringSpec("type"),
    stringSpec("certainty"),
    stringSpec("source-agent"),
    stringSpec("refs"),
    stringSpec("expires-after-days"),
    booleanSpec("no-conflicts"),
    booleanSpec("token-report"),
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
    semantic: booleanFlag("semantic"),
    hybrid: booleanFlag("hybrid"),
    ...outputConfig(),
  },
  [
    stringSpec("tags"),
    stringSpec("type"),
    stringSpec("certainty"),
    booleanSpec("include-deprecated"),
    stringSpec("limit"),
    booleanSpec("explain-score"),
    booleanSpec("semantic"),
    booleanSpec("hybrid"),
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
  { args: positionalArgs(), ...outputConfig() },
  outputSpecs,
  "read",
  handleGetCommand,
);
const updateCommand = effectCommand(
  "update",
  {
    args: positionalArgs(),
    match: stringFlag("match"),
    "from-file": stringFlag("from-file"),
    "dry-run": booleanFlag("dry-run"),
    tags: stringFlag("tags"),
    context: stringFlag("context"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    "updated-by": stringFlag("updated-by"),
    refs: stringFlag("refs"),
    "expires-after-days": stringFlag("expires-after-days"),
    "token-report": booleanFlag("token-report"),
    ...outputConfig(),
  },
  [
    stringSpec("match"),
    stringSpec("from-file"),
    booleanSpec("dry-run"),
    stringSpec("tags"),
    stringSpec("context"),
    stringSpec("type"),
    stringSpec("certainty"),
    stringSpec("updated-by"),
    stringSpec("refs"),
    stringSpec("expires-after-days"),
    booleanSpec("token-report"),
    ...outputSpecs,
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
    ...outputConfig(),
  },
  [
    stringSpec("match"),
    stringSpec("superseded-by"),
    stringSpec("updated-by"),
    ...outputSpecs,
  ],
  "write",
  handleDeprecateCommand,
);
const deleteCommand = effectCommand(
  "delete",
  { args: positionalArgs(), ...outputConfig() },
  outputSpecs,
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
  { args: positionalArgs(), ...outputConfig() },
  outputSpecs,
  "read",
  handleVerifyCommand,
);
const diffCommand = effectCommand(
  "diff",
  { args: positionalArgs(), ...outputConfig() },
  outputSpecs,
  "read",
  handleDiffCommand,
);
const coverageCommand = effectCommand(
  "coverage",
  { args: positionalArgs(), root: stringFlag("root"), ...outputConfig() },
  [stringSpec("root"), ...outputSpecs],
  "read",
  handleCoverageCommand,
);
const gcCommand = effectCommand(
  "gc",
  {
    args: positionalArgs(),
    "dry-run": booleanFlag("dry-run"),
    ...outputConfig(),
  },
  [booleanSpec("dry-run"), ...outputSpecs],
  "read",
  handleGcCommand,
);
const statsCommand = effectCommand(
  "stats",
  { ...outputConfig() },
  outputSpecs,
  "read",
  handleStatsCommand,
);
const sizeCommand = effectCommand(
  "size",
  {
    args: positionalArgs(),
    "from-file": stringFlag("from-file"),
    tags: stringFlag("tags"),
    context: stringFlag("context"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    local: booleanFlag("local"),
    remote: booleanFlag("remote"),
    ...outputConfig(),
  },
  [
    stringSpec("from-file"),
    stringSpec("tags"),
    stringSpec("context"),
    stringSpec("type"),
    stringSpec("certainty"),
    booleanSpec("local"),
    booleanSpec("remote"),
    ...outputSpecs,
  ],
  undefined,
  handleSizeCommand,
);
const importCommand = effectCommand(
  "import",
  { args: positionalArgs() },
  [],
  "write",
  handleImportCommand,
);
const reindexCommand = effectCommand(
  "reindex",
  outputConfig(),
  outputSpecs,
  "write",
  handleReindexCommand,
);
const exportCommand = effectCommand(
  "export",
  {
    args: positionalArgs(),
    tags: stringFlag("tags"),
    type: stringFlag("type"),
    certainty: stringFlag("certainty"),
    since: stringFlag("since"),
    ...outputConfig(),
  },
  [
    stringSpec("tags"),
    stringSpec("type"),
    stringSpec("certainty"),
    stringSpec("since"),
    ...outputSpecs,
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
const initCommand = effectCommand(
  "init",
  {
    local: booleanFlag("local"),
    remote: booleanFlag("remote"),
    mcp: booleanFlag("mcp"),
  },
  [booleanSpec("local"), booleanSpec("remote"), booleanSpec("mcp")],
  undefined,
  handleInitCommand,
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
  sizeCommand,
  importCommand,
  reindexCommand,
  exportCommand,
  migrateCommand,
  tagMapCommand,
  initCommand,
  localCommand,
  remoteCommand,
] as const;

function printUpgradeProgress(progress: UpgradeProgress): void {
  switch (progress.phase) {
    case "checking":
      console.info(`  ${pc.cyan("…")} Checking for the latest release`);
      return;
    case "found":
      if (progress.updateAvailable) {
        console.info(
          `  ${pc.green("✓")} Found ${pc.cyan(`v${progress.latestVersion}`)} ${pc.dim(`(current v${progress.currentVersion})`)}`,
        );
      } else {
        console.info(
          `  ${pc.green("✓")} Already on the latest version ${pc.cyan(`v${progress.currentVersion}`)}`,
        );
      }
      return;
    case "downloading":
      console.info(
        `  ${pc.cyan("…")} Downloading ${pc.dim(progress.assetName)}`,
      );
      return;
    case "installing":
      console.info(`  ${pc.cyan("…")} Installing the new version`);
      return;
  }
}

function printUpgradeResult(result: JsonObject): void {
  if (result.message === "Already up to date") {
    console.info();
    console.info(pc.green(pc.bold("✓ machine-memory is up to date")));
    console.info();
    return;
  }

  console.info();
  console.info(pc.green(pc.bold("✓ machine-memory upgraded successfully")));
  console.info(
    `  ${pc.dim("Version")}  ${pc.cyan(`v${jsonString(result.from) ?? jsonNumber(result.from)?.toString() ?? "?"}`)} ${pc.dim("→")} ${pc.green(`v${jsonString(result.to) ?? jsonNumber(result.to)?.toString() ?? "?"}`)}`,
  );
  console.info();
}

function startUpgradeOutput(): UpgradeOptions {
  console.info();
  console.info(pc.bold("machine-memory upgrade"));
  console.info(`${pc.dim("Current")}  ${pc.cyan(`v${VERSION}`)}`);
  console.info();
  return { onProgress: printUpgradeProgress };
}

export function builtinCommands() {
  const helpCommand = Command.make("help", {}, () =>
    Effect.gen(function* () {
      const pretty = yield* prettyOutput;
      yield* Effect.sync(() =>
        printCommandOutput(
          { command: "help", outputMode: outputModeForPretty(pretty) },
          helpPayload(),
        ),
      );
    }),
  );
  const versionCommand = Command.make("version", {}, () =>
    Effect.gen(function* () {
      const pretty = yield* prettyOutput;
      yield* Effect.sync(() =>
        printCommandOutput(
          { command: "version", outputMode: outputModeForPretty(pretty) },
          { version: VERSION },
        ),
      );
    }),
  );
  const upgradeCommand = Command.make("upgrade", {}, () =>
    Effect.sync(startUpgradeOutput).pipe(
      Effect.flatMap((options) => upgrade(options)),
      Effect.tap((result) => Effect.sync(() => printUpgradeResult(result))),
    ),
  );
  return [helpCommand, versionCommand, upgradeCommand] as const;
}

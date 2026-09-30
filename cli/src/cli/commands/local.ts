import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import pc from "picocolors";

import {
  booleanFlag,
  booleanSpec,
  effectCommand,
  positionalArgs,
  stringFlag,
  stringSpec,
} from "../runtime/command";
import { handleLocalExport } from "./remote-migrate";

const localExportCommand = effectCommand(
  "export",
  {
    args: positionalArgs(),
    remote: booleanFlag("remote"),
    "source-id": stringFlag("source-id"),
  },
  [booleanSpec("remote"), stringSpec("source-id")],
  undefined,
  handleLocalExport,
);

export const localCommand = Command.make("local", {}, () =>
  Effect.sync(() => {
    console.info(`${pc.bold("Usage:")} machine-memory local <export>`);
    console.info(
      `${pc.dim("Export:")} machine-memory local export [local-db-path] --remote`,
    );
  }),
).pipe(Command.withSubcommands([localExportCommand]));

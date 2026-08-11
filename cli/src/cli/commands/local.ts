import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import pc from "picocolors";
import { handleLocalExport } from "./remote-migrate";
import {
  booleanFlag,
  booleanSpec,
  effectCommand,
  positionalArgs,
} from "../runtime/command";

const localExportCommand = effectCommand(
  "export",
  {
    args: positionalArgs(),
    remote: booleanFlag("remote"),
  },
  [booleanSpec("remote")],
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

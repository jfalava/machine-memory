import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { runCli } from "./lib/cli/app";

BunRuntime.runMain(
  Effect.promise(() => runCli(process.argv.slice(2))),
  { disableErrorReporting: true },
);

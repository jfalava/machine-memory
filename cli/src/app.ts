import { BunRuntime } from "@effect/platform-bun";
import { runCli } from "./lib/cli/app";

BunRuntime.runMain(runCli(process.argv.slice(2)), {
  disableErrorReporting: true,
});

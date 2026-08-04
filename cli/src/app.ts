import { BunRuntime } from "@effect/platform-bun";
import { runCli } from "./cli/app";

BunRuntime.runMain(runCli(process.argv.slice(2)), {
  disableErrorReporting: true,
});

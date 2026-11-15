import {
  getFlagValue,
  hasFlag,
  usageError,
  type CommandFlags,
} from "./cli-utils";

type Environment = Readonly<Record<string, string | undefined>>;

function withThread(agent: string, thread: string | undefined): string {
  return thread ? `${agent}:${thread}` : agent;
}

/**
 * Who is writing, as `<agent>:<thread>`, or "" when the harness is unknown.
 * MACHINE_MEMORY_AGENT wins, and an empty value turns attribution off. Amp's
 * variables are observed in a live thread; Claude Code's and Codex's are the
 * names their binaries export to child processes.
 */
export function currentWriter(env: Environment = process.env): string {
  if (env["MACHINE_MEMORY_AGENT"] !== undefined) {
    return env["MACHINE_MEMORY_AGENT"].trim();
  }
  if (env["AGENT_THREAD_ID"]) {
    return withThread(env["AGENT"] || "agent", env["AGENT_THREAD_ID"]);
  }
  if (env["CLAUDECODE"] === "1") {
    return withThread("claude-code", env["CLAUDE_CODE_SESSION_ID"]);
  }
  if (env["CODEX_THREAD_ID"]) {
    return withThread("codex", env["CODEX_THREAD_ID"]);
  }
  return env["AGENT"]?.trim() ?? "";
}

/** The writer named by --by, or this session's with --mine; undefined when neither is given. */
export function requestedWriter(flags: CommandFlags): string | undefined {
  const by = getFlagValue(flags, "--by");
  const mine = hasFlag(flags, "--mine");
  if (by !== undefined && mine) {
    usageError("Use either --by <writer> or --mine, not both.");
  }
  if (hasFlag(flags, "--by") && !by) {
    usageError("--by needs a writer, such as amp or amp:T-1234.");
  }
  if (!mine) {
    return by;
  }
  const writer = currentWriter();
  if (writer === "") {
    usageError(
      "--mine needs to know who is running: no agent harness was detected. Set MACHINE_MEMORY_AGENT, or name the writer with --by.",
    );
  }
  return writer;
}

/**
 * Restrict a read to memories `writer` created or last changed. A bare agent
 * name such as `amp` matches every thread of that agent.
 */
export function appendWriterFilter(
  clauses: string[],
  params: (string | number)[],
  writer: string | undefined,
): void {
  if (writer === undefined) {
    return;
  }
  const threads = `${writer.replaceAll(/[\\%_]/g, String.raw`\$&`)}:%`;
  clauses.push(
    String.raw`(source_agent = ? OR last_updated_by = ? OR source_agent LIKE ? ESCAPE '\' OR last_updated_by LIKE ? ESCAPE '\')`,
  );
  params.push(writer, writer, threads, threads);
}

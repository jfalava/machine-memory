import { describe, expect, it } from "vitest";

import { currentWriter } from "../src/attribution";

describe("currentWriter", () => {
  it.each([
    ["Amp", { AGENT: "amp", AGENT_THREAD_ID: "T-1" }, "amp:T-1"],
    ["a thread id with no agent name", { AGENT_THREAD_ID: "T-1" }, "agent:T-1"],
    [
      "Claude Code",
      { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s-1" },
      "claude-code:s-1",
    ],
    ["Claude Code without a session id", { CLAUDECODE: "1" }, "claude-code"],
    ["Codex", { CODEX_THREAD_ID: "c-1" }, "codex:c-1"],
    ["an agent name alone", { AGENT: "goose" }, "goose"],
    ["no harness", { PATH: "/bin" }, ""],
    [
      "an explicit name over a detected harness",
      {
        MACHINE_MEMORY_AGENT: " reviewer ",
        AGENT: "amp",
        AGENT_THREAD_ID: "T-1",
      },
      "reviewer",
    ],
    [
      "an empty explicit name, which turns attribution off",
      { MACHINE_MEMORY_AGENT: "", AGENT: "amp", AGENT_THREAD_ID: "T-1" },
      "",
    ],
  ])("names %s", (_label, env, expected) => {
    expect(currentWriter(env)).toBe(expected);
  });
});

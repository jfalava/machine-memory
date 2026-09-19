import { describe, expect, it } from "vitest";
import { CommandError } from "@/effect/errors";
import {
  commandErrorForRender,
  humanCommandFailureOutput,
  storedRemoteCredentialsError,
} from "@/cli/human-error";

describe("human command failure output", () => {
  it("keeps the heading on stderr and the hint on stdout", () => {
    const output = humanCommandFailureOutput(
      new CommandError({
        command: "remote setup",
        message: "Could not read stored remote credentials from the OS keychain.",
        cause: undefined,
        hint: "Unlock the OS keychain, or set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKEN.",
      }),
    );

    expect(output.stderr.join("\n")).toContain("✗ remote setup failed");
    expect(output.stderr.join("\n")).toContain(
      "Could not read stored remote credentials from the OS keychain.",
    );
    expect(output.stderr.join("\n")).not.toContain("Next:");
    expect(output.stderr.join("\n")).not.toContain("Hint");
    expect(output.stdout.join("\n")).toContain("Hint");
    expect(output.stdout.join("\n")).toContain("Unlock the OS keychain");
    expect(output.stdout.join("\n")).not.toContain("✗");
  });

  it("omits a hint line when the error has none", () => {
    const output = humanCommandFailureOutput(
      new CommandError({
        command: "init",
        message: "Choose exactly one init target: --local, --remote, or --mcp.",
        cause: undefined,
      }),
    );

    expect(output.stdout).toEqual([]);
    expect(output.stderr.join("\n")).toContain("✗ init failed");
    expect(output.stderr.join("\n")).not.toContain("Next:");
  });
});

describe("stored remote credential errors", () => {
  it("hints at overwrite when stored credentials are invalid", () => {
    const error = storedRemoteCredentialsError(
      new Error(
        "Stored remote credentials are invalid. Set MACHINE_MEMORY_DB_URL and MACHINE_MEMORY_DB_TOKEN or run 'machine-memory remote setup' again to overwrite them.",
      ),
      "remote setup",
    );

    expect(error.message).toBe("Stored remote credentials are invalid.");
    expect(error.hint).toContain("overwrite them with machine-memory remote setup");
  });

  it("hints at the keychain when the secret store cannot be read", () => {
    const error = storedRemoteCredentialsError(
      new Error("Secret service is locked"),
      "remote provision",
    );

    expect(error.command).toBe("remote provision");
    expect(error.message).toBe(
      "Could not read stored remote credentials from the OS keychain.",
    );
    expect(error.hint).toContain("Unlock the OS keychain");
    expect(error.hint).toContain("MACHINE_MEMORY_DB_TOKEN");
  });
});

describe("commandErrorForRender", () => {
  it("preserves the hint when retargeting the command name", () => {
    const source = storedRemoteCredentialsError(
      new Error("Secret service is locked"),
      "remote setup",
    );
    const rendered = commandErrorForRender("remote provision", source);

    expect(rendered.command).toBe("remote provision");
    expect(rendered.hint).toBe(source.hint);
    expect(rendered.message).toBe(source.message);
  });
});

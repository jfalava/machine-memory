import type { ErrorToolResult, TextToolResult } from "./types";

export function textResult(rows: unknown[]): TextToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
  };
}

export function textMessage(message: string): TextToolResult {
  return {
    content: [{ type: "text", text: message }],
  };
}

export function errorResult(cause: unknown): ErrorToolResult {
  return {
    content: [
      {
        type: "text",
        text: cause instanceof Error ? cause.message : "Internal server error.",
      },
    ],
    isError: true,
  };
}

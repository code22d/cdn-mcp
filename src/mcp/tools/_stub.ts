// -----------------------------------------------------------------------------
// Phase 0 stub handler factory.
//
// Every tool in Phase 0 returns the same shape:
//   result: {
//     content: [{ type: "text", text: JSON.stringify({
//       error: "not_yet_implemented",
//       phase: "0",
//       tool: "<name>"
//     }) }],
//     isError: true
//   }
//
// `isError: true` is deliberate (head-session decision A2):
//   - The MCP `isError` flag is the canonical "tool didn't do what you asked"
//     signal. A stub IS a failure from the caller's perspective.
//   - Belt-and-suspenders: structured payload makes intent clear, isError
//     makes the connector UI handle it correctly, and a future caller that
//     ignores the payload still gets a valid signal.
//
// Phase 1+ swaps this handler for the real implementation. The tool's
// name/description/inputSchema MUST NOT change — the surface is frozen.
// -----------------------------------------------------------------------------

import type { ToolContext, ToolResult } from "../../types";

export function stubHandler(toolName: string) {
  return async (
    _args: Record<string, unknown>,
    _ctx: ToolContext
  ): Promise<ToolResult> => {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "not_yet_implemented",
            phase: "0",
            tool: toolName,
          }),
        },
      ],
    };
  };
}

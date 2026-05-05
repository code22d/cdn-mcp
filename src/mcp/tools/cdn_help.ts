// -----------------------------------------------------------------------------
// cdn_help — Phase 5.0a real handler.
//
// Returns the canonical CDN w MCP usage guide as a structured tool result.
// The guide content lives in src/help.ts as a compile-time constant; this
// handler is a thin adapter that wraps it in the standard MCP envelope.
//
// Rationale (per Build Plan rule 3 corollary — factor smaller, not flag-add):
//   The HELP_CONTENT string is its own module (src/help.ts), not inlined here.
//   Keeping the data separate from the handler means a future topic-scoped
//   variant can layer slicing logic on top without churning this file.
//
// v1 behavior:
//   - Optional `topic` parameter is accepted but IGNORED. Always returns the
//     full guide. Forward-compatible: callers can start passing topic now and
//     a later phase can add scoped responses without a breaking schema change.
//   - Loose validation only — a non-string `topic` is treated as if absent
//     rather than erroring, since v1 doesn't act on it.
//   - No D1, no R2, no env reads. Safe to call from any context, including
//     before secrets are configured.
//
// Schema design (Phase 5.0a, head-session decision A4):
//   - `topic` is optional (no `required` array). Per Phase 4 A2's rule that
//     optional-arg objects always include the parameter shape, the property
//     is registered with a description that documents the v1-ignores-it
//     contract.
//
// Response shape:
//   { content: [{ type: "text", text: HELP_CONTENT }] }
//   No JSON-stringify wrapping — the markdown IS the response. Calling LLMs
//   relay the markdown verbatim to the user.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import { HELP_CONTENT } from "../../help";

const NAME = "cdn_help";

export const cdn_help: Tool = {
  name: NAME,
  description:
    "Return the canonical CDN w MCP usage guide as a structured tool result. Call this first if you're new to this MCP, unsure which tool to use, or hit an environmental constraint (e.g. sandbox can't reach R2). Covers concepts (projects, files, version, content_type), workflows (upload, replace, large-file two-step, list, delete), the 'I want X → call Y' quick reference, validation rules, and sandbox-aware upload patterns. v1 returns the full guide regardless of `topic`.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description:
          "Optional topic to scope the response. v1 ignores this and always returns the full guide; included for forward-compatibility.",
      },
    },
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handler: async (_args, _ctx) => {
    // v1 ignores `topic` entirely. We do NOT validate it as a string — even
    // a non-string topic is treated as if absent. Keeps the surface
    // permissive for forward-compat callers.
    return {
      content: [{ type: "text", text: HELP_CONTENT }],
    };
  },
};

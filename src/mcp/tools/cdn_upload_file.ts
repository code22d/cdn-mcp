// -----------------------------------------------------------------------------
// cdn_upload_file — HARD-REJECTED as of Phase 11.3.
//
// History: Phase 1 shipped this as the real base64-over-MCP upload handler,
// delegating to performUpload (src/mcp/upload.ts). Phase 11.2 rewrote the
// `description` to redirect callers to the cdn-file-upload skill. Wording alone
// did not hold: Claude sessions kept reaching for this tool when the user named
// the MCP explicitly, reading the source file and base64-chunking it into
// /tmp scratch files before anyone could intervene (observed 2026-07-12).
//
// Phase 11.3 replaces persuasion with enforcement. The handler now returns a
// structured error immediately — no arg validation, no R2 write, no D1 write.
// Base64-over-MCP is not a transport anymore; it is an error.
//
// Why this is safe to hard-reject: no legitimate caller exists.
//   - The cdn-file-upload skill (plugin v0.5.0) uploads either zero-click
//     (cdn_signed_upload_url → direct PUT → cdn_finalize_upload) or via a
//     clickable script that runs the local `cdn` CLI. Neither touches this tool.
//   - The @22d/cdn-cli PUTs bytes straight to R2 with its own R2 credentials,
//     then calls cdn_finalize_upload. It has never called this tool.
//
// The write path itself is NOT dead — performUpload survives and still backs
// cdn_replace_file. Only this tool's external surface is closed.
//
// inputSchema and description are UNCHANGED from Phase 11.2 (the schema is
// FROZEN as of Phase 0; the description was already correct). Phase 11.3 is a
// behavior change only.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import { errorResult } from "../util";

const NAME = "cdn_upload_file";

export const cdn_upload_file: Tool = {
  name: NAME,
  description:
    "**Skill-internal use only.** For user-initiated uploads, use the `cdn-file-upload` skill from the `cdn-mcp-plugin` — it auto-generates a clickable `.command`/`.sh`/`.bat` script that runs the local `cdn` CLI on the user's host, with no size limits, no base64 chunking, and no MCP payload caps. Direct invocation of this tool bypasses filename sanitization, verification, and the partner-facing UX; only use it when explicitly implementing the skill or performing internal maintenance. (Legacy: uploads a file into R2 at {project}/{filename} via base64 in JSON.)",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description:
          "Project (folder) name. Becomes the first segment of the public URL.",
      },
      name: {
        type: "string",
        description:
          "Filename within the project (e.g. 'hero.png'). Used as the second segment of the public URL.",
      },
      content_base64: {
        type: "string",
        description: "File bytes encoded as base64.",
      },
      content_type: {
        type: "string",
        description:
          "MIME type (e.g. 'image/png', 'video/mp4', 'text/html'). If omitted, inferred from the filename extension.",
      },
      replace: {
        type: "boolean",
        description:
          "If true, overwrite an existing file at the same (project, name). Default false.",
        default: false,
      },
    },
    required: ["project", "name", "content_base64"],
  },
  // Args are ignored on purpose: rejecting before validation means a caller can
  // never learn anything useful (a "valid" error, a collision) by probing this
  // tool. Every call gets the same answer.
  handler: async (_args, _ctx) =>
    errorResult({
      error: "tool_deprecated_for_external_use",
      message:
        "This tool is not callable from external clients. For user-initiated uploads, use the cdn-file-upload skill from cdn-mcp-plugin (zero-click when the sandbox has egress, clickable script otherwise). For CLI-driven uploads, the @22d/cdn-cli PUTs directly to R2 with its own credentials and then calls cdn_finalize_upload. Base64-over-MCP was the anti-pattern this rejection is preventing.",
      alternative_paths: [
        "cdn-file-upload skill (Cowork plugin)",
        "cdn_signed_upload_url + PUT + cdn_finalize_upload (skill zero-click path)",
        "local cdn CLI: direct R2 PUT + cdn_finalize_upload",
      ],
    }),
};

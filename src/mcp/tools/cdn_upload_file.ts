// -----------------------------------------------------------------------------
// cdn_upload_file — Phase 1 real handler. Phase 2 refactored the body out into
// src/mcp/upload.ts so cdn_replace_file can share it (head-session A1 +
// Phase 1 A7 — both confirm a single canonical overwrite path).
//
// Flow (delegated to performUpload with requireExisting: false):
//   1. Validate project + filename + base64.
//   2. Look up existing (project, name) row in D1.
//   3. If exists and !replace → error file_exists.
//   4. Auto-create project (INSERT OR IGNORE) so collisions on the explicit
//      cdn_create_project path still produce a meaningful "exists" error.
//   5. R2 PUT the bytes (httpMetadata.contentType set so direct fetches from
//      cdn.22d.app return the right Content-Type header).
//   6. D1 INSERT (new file) or UPDATE (replace).
//      - On INSERT failure: best-effort R2 delete to avoid orphan bytes.
//      - On UPDATE failure (replace path): return metadata_update_failed —
//        the new bytes are already at the public URL, the row just didn't
//        get its version/timestamp bumped. User should retry.
//
// Schema is FROZEN as of Phase 0. Only the handler body was refactored — the
// inputSchema and description are unchanged.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import { performUpload } from "../upload";

const NAME = "cdn_upload_file";

export const cdn_upload_file: Tool = {
  name: NAME,
  description:
    "Upload bytes into a project, base64-encoded in the request. Auto-creates the project if missing. Errors with `file_exists` unless `replace: true`. Best for files <5MB — base64 inflates calling-session context. For 5–50MB from inside a sandboxed session, fan out via subagents (each subagent holds the base64 in its own context). For >50MB, use `cdn_signed_upload_url` instead. See `cdn_help` for full upload-pattern guidance.",
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
  handler: async (args, ctx) =>
    performUpload(args, ctx, { requireExisting: false }),
};

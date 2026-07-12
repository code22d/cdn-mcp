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
// inputSchema is FROZEN as of Phase 0 and remains untouched. Phase 11.2 rewrote
// the `description` only: partners kept reaching for this tool directly (base64
// small-file uploads) instead of the cdn-file-upload skill, so the description
// now redirects to the skill. Behavior is unchanged — this is tool-surface
// wording, not contract.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import { performUpload } from "../upload";

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
  handler: async (args, ctx) =>
    performUpload(args, ctx, { requireExisting: false }),
};

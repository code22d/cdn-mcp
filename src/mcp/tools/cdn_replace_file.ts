// -----------------------------------------------------------------------------
// cdn_replace_file — Phase 2 real handler.
//
// Thin wrapper around performUpload (src/mcp/upload.ts) with
// `requireExisting: true`. Behavior diff vs. cdn_upload_file:
//
//   - If no row exists at (project, name) → error file_not_found.
//     (cdn_upload_file would treat that as a new upload.)
//   - The `replace` flag from upload's schema is implicit here — replace
//     semantics are always on, since the row by definition already exists.
//   - Returns the same response envelope as cdn_upload_file's replace branch:
//     { url, project, name, size_bytes, content_type, uploaded_at,
//       last_replaced_at, version } where version = existing.version + 1.
//
// Phase 2 head-session decision A2 (content_type inference on omit):
//   The Phase 0 stub schema described content_type as "preserved from the
//   existing row" if omitted. Phase 2 changed the field's description text to
//   match the production behavior — same inference rule as cdn_upload_file:
//   omit → infer from filename extension. The schema parameter shape (type,
//   required-ness) is unchanged. Rule going forward: schema parameter shape
//   is frozen, description text is mutable when behavior changes warrant it.
//
// Phase 1 head-session decision A6 carries through performUpload:
//   R2 PUT first, then D1 UPDATE. Asymmetric rollback — if the UPDATE fails
//   the new bytes stay at the public URL and the response carries a
//   `metadata_update_failed` error with retry guidance. The wrapper does not
//   change this contract.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import { performUpload } from "../upload";

const NAME = "cdn_replace_file";

export const cdn_replace_file: Tool = {
  name: NAME,
  description:
    "Overwrite an existing file in place. Same R2 key, same public URL — embedded links don't break. Bumps `version`, sets `last_replaced_at`. Errors with `file_not_found` if the file doesn't exist (use `cdn_upload_file` to create). Cache window is ~60s; for instant verification fetch with `?v=<n>` or `?bust=<timestamp>`. Same size guidance as `cdn_upload_file`.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project (folder) name containing the file to replace.",
      },
      name: {
        type: "string",
        description: "Filename within the project.",
      },
      content_base64: {
        type: "string",
        description: "Replacement bytes encoded as base64.",
      },
      content_type: {
        type: "string",
        description:
          "MIME type for the new bytes (e.g. 'image/png'). If omitted, inferred from the filename extension — same rule as cdn_upload_file.",
      },
    },
    required: ["project", "name", "content_base64"],
  },
  handler: async (args, ctx) =>
    performUpload(args, ctx, { requireExisting: true }),
};

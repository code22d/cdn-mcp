// -----------------------------------------------------------------------------
// cdn_signed_upload_url — Phase 4 real handler.
//
// Workaround for Worker request-body limits (~100MB): generate a presigned R2
// URL so very large files (videos, archives) can be uploaded direct from the
// browser/client to R2, bypassing the Worker entirely. After a successful PUT
// to the presigned URL, the client must call `cdn_finalize_upload` to insert
// the metadata row into D1.
//
// Phase 4 head-session decisions reflected here:
//   A2: required_headers is always present. Empty object when no extra
//       headers are required, populated when a Content-Type was signed.
//       Caller can iterate without null-check.
//   A3: expires_at is computed locally
//       (Date.now() + expires_in_seconds * 1000). aws4fetch doesn't surface
//       its embedded X-Amz-Date+Expires as an API field; the local compute
//       is microseconds off and adequate at the 15-minute granularity we use.
//
// Critical contract: this handler does NOT write to D1. The metadata row is
// inserted by cdn_finalize_upload AFTER a successful PUT — that way an
// abandoned presign creates no orphan D1 row.
//
// Schema is FROZEN as of Phase 0. Verified character-for-character against
// the deployed inputSchema during the Phase 4 pre-flight (rule 1).
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import { buildPresignedPut } from "../sigv4";
import {
  errorResult,
  okResult,
  validateFileName,
  validateProjectName,
} from "../util";

const NAME = "cdn_signed_upload_url";
const DEFAULT_EXPIRES_IN_SECONDS = 900;
const MIN_EXPIRES_IN_SECONDS = 60;
const MAX_EXPIRES_IN_SECONDS = 3600;

interface ExistingFileRow {
  id: string;
}

export const cdn_signed_upload_url: Tool = {
  name: NAME,
  description:
    "Generate a short-lived presigned R2 URL for direct browser-to-R2 PUT uploads. Use this for files larger than the Worker request-body limit (~100MB). After a successful PUT to the returned URL, call cdn_finalize_upload to record the file's metadata.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project (folder) name the file will live under.",
      },
      name: {
        type: "string",
        description: "Filename within the project.",
      },
      content_type: {
        type: "string",
        description:
          "MIME type of the file to be uploaded. Embedded in the presigned URL.",
      },
      expires_in_seconds: {
        type: "integer",
        description:
          "How long the presigned URL is valid, in seconds (60–3600).",
        minimum: MIN_EXPIRES_IN_SECONDS,
        maximum: MAX_EXPIRES_IN_SECONDS,
        default: DEFAULT_EXPIRES_IN_SECONDS,
      },
      replace: {
        type: "boolean",
        description:
          "If true, the upload may overwrite an existing file at (project, name). Default false.",
        default: false,
      },
    },
    required: ["project", "name"],
  },
  handler: async (args, ctx) => {
    // -------------------------------------------------------------------
    // 1. Validate inputs (validators fire BEFORE any I/O — same rule as
    //    every other handler in this codebase).
    // -------------------------------------------------------------------
    const projectErr = validateProjectName(args.project);
    if (projectErr) {
      return errorResult({ error: "invalid_project", message: projectErr });
    }
    const project = args.project as string;

    const nameErr = validateFileName(args.name);
    if (nameErr) {
      return errorResult({ error: "invalid_name", message: nameErr });
    }
    const name = args.name as string;

    // expires_in_seconds: integer in [60, 3600]. Default 900.
    let expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS;
    if (args.expires_in_seconds !== undefined) {
      const raw = args.expires_in_seconds;
      if (
        typeof raw !== "number" ||
        !Number.isInteger(raw) ||
        raw < MIN_EXPIRES_IN_SECONDS ||
        raw > MAX_EXPIRES_IN_SECONDS
      ) {
        return errorResult({
          error: "invalid_expires_in_seconds",
          message: `expires_in_seconds must be an integer in [${MIN_EXPIRES_IN_SECONDS}, ${MAX_EXPIRES_IN_SECONDS}].`,
        });
      }
      expiresInSeconds = raw;
    }

    // content_type: optional, must be a non-empty string if provided. We do
    // NOT infer from filename here — the spec is "embed in the presigned URL
    // if provided, leave Content-Type unsigned otherwise." If the caller
    // wants inference they pass it explicitly.
    let contentType: string | undefined;
    if (args.content_type !== undefined) {
      if (typeof args.content_type !== "string" || args.content_type.length === 0) {
        return errorResult({
          error: "invalid_content_type",
          message: "content_type must be a non-empty string when provided.",
        });
      }
      contentType = args.content_type;
    }

    const replace = args.replace === true;

    // -------------------------------------------------------------------
    // 2. file_exists guard — refuse to issue a URL that would silently
    //    overwrite an existing file unless the caller passed replace: true.
    //
    //    Symmetric with cdn_upload_file's collision branch. Note we do NOT
    //    auto-create the project here — that's deferred to finalize, same
    //    way upload defers it until the actual write commits.
    // -------------------------------------------------------------------
    const existing = await ctx.env.DB.prepare(
      "SELECT id FROM files WHERE project = ? AND name = ?"
    )
      .bind(project, name)
      .first<ExistingFileRow>();

    if (existing && !replace) {
      return errorResult({
        error: "file_exists",
        message: `File exists at ${project}/${name}. Pass replace: true to overwrite.`,
      });
    }

    // -------------------------------------------------------------------
    // 3. Sign.
    // -------------------------------------------------------------------
    const r2Key = `${project}/${name}`;
    let presigned;
    try {
      presigned = await buildPresignedPut(ctx.env, {
        r2Key,
        contentType,
        expiresInSeconds,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return errorResult({
        error: "sign_failed",
        message:
          "Could not produce a presigned URL — likely missing R2 credentials. Verify `wrangler secret list` shows R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY.",
        detail,
      });
    }

    // -------------------------------------------------------------------
    // 4. Build response. expires_at is computed locally (Phase 4 A3) —
    //    aws4fetch doesn't expose its embedded expiry as an API field, and
    //    the local compute is microseconds off at most.
    // -------------------------------------------------------------------
    const expiresAt = new Date(
      Date.now() + expiresInSeconds * 1000
    ).toISOString();
    const publicUrlAfterFinalize = `${ctx.env.PUBLIC_URL_PREFIX}/${r2Key}`;

    return okResult({
      upload_url: presigned.url,
      method: "PUT",
      expires_at: expiresAt,
      expires_in_seconds: expiresInSeconds,
      project,
      name,
      public_url_after_finalize: publicUrlAfterFinalize,
      // Always present — empty object when no Content-Type was signed (A2).
      required_headers: presigned.requiredHeaders,
    });
  },
};

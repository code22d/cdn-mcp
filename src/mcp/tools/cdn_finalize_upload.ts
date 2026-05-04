// -----------------------------------------------------------------------------
// cdn_finalize_upload — Phase 4 real handler.
//
// Companion to cdn_signed_upload_url. After the client successfully PUTs the
// file bytes directly to R2 via the presigned URL, it calls this tool to
// insert/update the file metadata row in D1, making the file visible to
// cdn_list_files / cdn_get_file / cdn_get_stats.
//
// Flow:
//   1. Validate inputs (project, name, content_type non-empty, size_bytes >= 0).
//   2. R2 head() the key — fail r2_object_not_found if missing.
//   3. Compare reported size_bytes against R2's actual size — fail
//      size_mismatch on divergence (catches partial uploads).
//   4. Auto-create project (INSERT OR IGNORE) — same pattern as performUpload.
//   5. Look up the existing D1 row at (project, name) — finalize works for
//      both fresh inserts AND replace (presigned URL was issued with
//      replace: true).
//   6. Delegate to commitFileMetadata with rollbackOnInsertFailure: false.
//      The bytes are already at R2 and we did NOT put them — never sweep
//      them on a metadata-side failure. Finalize is idempotent on retry.
//
// Phase 4 head-session decisions reflected here:
//   A1: this is the third caller of the shared write-side logic, but it's
//       NOT the third caller of performUpload. Per Build Plan rule 3's
//       corollary, finalize calls the smaller commitFileMetadata directly
//       — extraction over flag-add when the caller's spec is a strict subset.
//   A4: size_bytes: 0 is allowed. R2 supports zero-byte objects (placeholders,
//       lockfiles, marker files). Validation reads `>= 0`, not `> 0`.
//   A5: on a replace, the new content_type from the finalize call wins. The
//       R2 object's actual byte-level Content-Type was set at PUT time by
//       the presigned URL signing — D1 records what the client reports here.
//   Don't-rollback-bytes asymmetry: mirrors the Phase 2 A6 replace-side
//       contract. The presigned PUT succeeded; we never delete bytes we
//       didn't upload.
//
// Schema is FROZEN as of Phase 0. Verified character-for-character against
// the deployed inputSchema during the Phase 4 pre-flight (rule 1). All four
// fields required: project, name, content_type, size_bytes.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import { commitFileMetadata } from "../upload";
import {
  errorResult,
  validateFileName,
  validateProjectName,
} from "../util";

const NAME = "cdn_finalize_upload";

interface ExistingFileRow {
  id: string;
  version: number;
  uploaded_at: string;
}

export const cdn_finalize_upload: Tool = {
  name: NAME,
  description:
    "Finalize a presigned R2 upload by inserting the corresponding metadata row into D1. Called by the client after a successful direct-to-R2 PUT via the URL produced by cdn_signed_upload_url.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string" },
      name: { type: "string" },
      content_type: { type: "string" },
      size_bytes: { type: "integer" },
    },
    required: ["project", "name", "content_type", "size_bytes"],
  },
  handler: async (args, ctx) => {
    // -------------------------------------------------------------------
    // 1. Validate inputs.
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

    if (
      typeof args.content_type !== "string" ||
      args.content_type.length === 0
    ) {
      return errorResult({
        error: "invalid_content_type",
        message: "content_type must be a non-empty string.",
      });
    }
    const contentType = args.content_type;

    if (
      typeof args.size_bytes !== "number" ||
      !Number.isInteger(args.size_bytes) ||
      args.size_bytes < 0
    ) {
      return errorResult({
        error: "invalid_size_bytes",
        message: "size_bytes must be a non-negative integer.",
      });
    }
    const sizeBytes = args.size_bytes;

    const r2Key = `${project}/${name}`;
    const publicUrl = `${ctx.env.PUBLIC_URL_PREFIX}/${r2Key}`;

    // -------------------------------------------------------------------
    // 2. R2 head() — sanity check the bytes are actually there.
    //
    // Without this, a client that never PUT (or whose PUT failed silently)
    // would still get a D1 row written, leaving cdn_list_files lying about
    // what's actually downloadable. The head() is the only verification
    // layer we have for the presigned-URL path.
    // -------------------------------------------------------------------
    const r2Object = await ctx.env.ASSETS.head(r2Key);
    if (!r2Object) {
      return errorResult({
        error: "r2_object_not_found",
        message: `No R2 object at ${r2Key}. Did the presigned PUT complete?`,
      });
    }

    // -------------------------------------------------------------------
    // 3. Size verify — catches partial uploads and client bugs.
    //
    // R2's R2Object.size is authoritative. If the client claims one size
    // and the bucket holds another, refuse to commit metadata that lies.
    // -------------------------------------------------------------------
    if (r2Object.size !== sizeBytes) {
      return errorResult({
        error: "size_mismatch",
        message: `Reported size_bytes (${sizeBytes}) does not match R2 object size (${r2Object.size}).`,
      });
    }

    // -------------------------------------------------------------------
    // 4. Auto-create project (no-op if it already exists). Same rule as
    //    performUpload — projects are auto-created on first commit, never
    //    on URL issuance.
    // -------------------------------------------------------------------
    const now = new Date().toISOString();
    await ctx.env.DB.prepare(
      "INSERT OR IGNORE INTO projects (name, description, created_at) VALUES (?, NULL, ?)"
    )
      .bind(project, now)
      .run();

    // -------------------------------------------------------------------
    // 5. Look up existing row — branches commitFileMetadata into INSERT
    //    vs UPDATE. Finalize covers BOTH cases:
    //      - First-time finalize after a presign with replace: false →
    //        existing is null → INSERT branch → version: 1.
    //      - Finalize after a presign with replace: true → existing is
    //        the prior row → UPDATE branch → version: version+1,
    //        last_replaced_at: now.
    //    The presign side already enforced the file_exists guard, so by
    //    the time we get here the caller has accepted the right semantics.
    // -------------------------------------------------------------------
    const existing = await ctx.env.DB.prepare(
      "SELECT id, version, uploaded_at FROM files WHERE project = ? AND name = ?"
    )
      .bind(project, name)
      .first<ExistingFileRow>();

    // -------------------------------------------------------------------
    // 6. Commit. rollbackOnInsertFailure: false — we did NOT put these
    //    bytes (the client did via the presigned URL), so we don't get to
    //    delete them on failure. Finalize is idempotent on retry: a fresh
    //    call with the same args will head() the same object, find
    //    existing == null again (the prior INSERT failed), and try the
    //    INSERT again.
    // -------------------------------------------------------------------
    const result = await commitFileMetadata(
      {
        project,
        name,
        r2Key,
        publicUrl,
        contentType,
        sizeBytes,
        now,
        existing: existing ?? null,
      },
      ctx,
      { rollbackOnInsertFailure: false }
    );

    // commitFileMetadata returns the canonical write-side envelope already.
    // Pass through unchanged so finalize and upload/replace are
    // indistinguishable to the connector.
    return result;
  },
};

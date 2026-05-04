// -----------------------------------------------------------------------------
// performUpload — the canonical R2-PUT-then-D1-mutate path.
// commitFileMetadata — the D1-only inner that ALL three write-side callers share.
//
// Three tools delegate here:
//   - cdn_upload_file       → performUpload(args, ctx, { requireExisting: false })
//   - cdn_replace_file      → performUpload(args, ctx, { requireExisting: true })
//   - cdn_finalize_upload   → commitFileMetadata(...) directly (no R2 PUT — bytes
//                              are already at R2 from the presigned-URL path)
//
// Why this is one module and not three:
//   - The Phase 1 head session (A7) declared the upload-with-replace path as
//     the canonical overwrite path. cdn_replace_file is a thin existence-
//     enforcing wrapper, not a separate implementation, so they MUST share
//     the same R2/D1 ordering and rollback logic.
//   - Phase 4 (cdn_finalize_upload) is the third caller per Build Plan
//     pre-flight rule 3. Because finalize's spec is a STRICT SUBSET of the
//     write-side path (no R2 PUT, no replace-flag collision branch), Phase 4
//     extracted commitFileMetadata as a separate inner function rather than
//     adding boolean flags to performUpload. Rule-3 corollary: "When a third
//     caller needs a strict subset of an existing shared function's behavior,
//     extract the subset rather than ballooning the conditional surface."
//
// Phase 1 head-session decisions reflected here:
//   A1: content_type is OPTIONAL on upload. Inferred from the filename
//       extension if missing. Fallback application/octet-stream. (Finalize's
//       schema marks content_type required — caller already chose it at
//       presign time — so the inference path is upload/replace-only.)
//   A6: R2 PUT first, then D1 mutate. On INSERT failure (new upload), best-
//       effort R2 delete to avoid orphan bytes. On UPDATE failure (replace),
//       leave the new bytes in place and return metadata_update_failed —
//       the asymmetric pattern is deliberate.
//
// Phase 2 head-session decisions reflected here:
//   A2 (Phase 2): cdn_replace_file omitting content_type infers from the
//       filename extension (same rule as upload), NOT preserve-from-row.
//
// Phase 4 head-session decisions reflected here:
//   A1 (Phase 4): refactor by extraction, not by flag. commitFileMetadata
//       owns "commit metadata for pre-verified bytes"; performUpload owns
//       "full upload pipeline".
//   A5 (Phase 4): on a finalize-replace, the new content_type from the
//       finalize call wins (mirrors the Phase 2 A2 rule). The R2 object's
//       actual byte-level Content-Type was set at PUT time by the presigned
//       URL signing — D1 records what the client reports in finalize.
//       Future hardening could verify finalize's content_type against
//       R2Object.httpMetadata.contentType from the head() call, but that's
//       deliberately out of scope until we see real divergence in production.
//   Finalize's rollback policy: rollbackOnInsertFailure: false. The bytes
//       are already at R2 from a successful presigned PUT. If D1 INSERT
//       fails, leaving the bytes in place is the right move — finalize is
//       idempotent on retry (head() still returns the same object, the
//       INSERT branch retries cleanly). Symmetric with the Phase 2 A6
//       replace-side asymmetry (don't roll back successful R2 writes).
// -----------------------------------------------------------------------------

import type { ToolContext, ToolResult } from "../types";
import {
  DEFAULT_CACHE_CONTROL,
  decodeBase64,
  errorResult,
  inferContentType,
  okResult,
  validateFileName,
  validateProjectName,
} from "./util";

interface ExistingFileRow {
  id: string;
  version: number;
  uploaded_at: string;
}

export interface PerformUploadOpts {
  /**
   * When true, error with `file_not_found` if no row exists at (project, name)
   * — the cdn_replace_file path. When false, allow new inserts (the
   * cdn_upload_file path), still erroring on collision unless `replace: true`.
   */
  requireExisting: boolean;
}

export interface CommitFileMetadataArgs {
  project: string;
  name: string;
  /** Already-set R2 key (`${project}/${name}`). Caller computes; we don't reparse. */
  r2Key: string;
  /** Public URL the response should advertise. */
  publicUrl: string;
  /** MIME the row should record. Caller resolves inference upstream. */
  contentType: string;
  /** Bytes. Verified against R2 by the caller for finalize; trusted-upstream for upload. */
  sizeBytes: number;
  /** ISO-8601 "now". Caller-supplied so the same value flows to both INSERT and the response. */
  now: string;
  /** Pre-fetched existing row (or null). Caller already paid for the SELECT. */
  existing: ExistingFileRow | null;
}

export interface CommitFileMetadataOpts {
  /**
   * Phase 1 A6 / Phase 4 A5: if a fresh INSERT fails, do we best-effort delete
   * the bytes from R2 to avoid orphans?
   *   - performUpload (cdn_upload_file new-file path): TRUE. We just put the
   *     bytes; rolling back is cheap and keeps the bucket clean.
   *   - cdn_finalize_upload: FALSE. The bytes were uploaded directly by the
   *     client via a presigned URL. We didn't put them, and a finalize retry
   *     succeeds against the same R2 object (head() unchanged, INSERT retried
   *     with the same args). Rolling back here would create a worse failure
   *     mode where the client thinks finalize failed but the bytes are gone.
   *
   * UPDATE failures (replace path) NEVER roll back R2, regardless of this
   * setting — the new bytes are already at the public URL and the row just
   * didn't get its version/timestamp bumped. The caller returns
   * metadata_update_failed and the user retries to bump.
   */
  rollbackOnInsertFailure: boolean;
}

/**
 * Commit file metadata to D1 for bytes that already exist at R2.
 *
 * Single responsibility: the D1 INSERT-vs-UPDATE branch shared by every
 * write-side caller. No R2 PUT, no validation (caller is responsible — they
 * already know the bytes are there), no project auto-create (caller decides).
 *
 * Returns the standard write-side response envelope:
 *   { url, project, name, size_bytes, content_type, uploaded_at,
 *     last_replaced_at, version }
 */
export async function commitFileMetadata(
  args: CommitFileMetadataArgs,
  ctx: ToolContext,
  opts: CommitFileMetadataOpts
): Promise<ToolResult> {
  const {
    project,
    name,
    r2Key,
    publicUrl,
    contentType,
    sizeBytes,
    now,
    existing,
  } = args;

  if (existing) {
    // Replace branch: UPDATE the existing row. Per Phase 1 A6, never roll
    // back R2 on UPDATE failure — the new bytes are already public.
    try {
      await ctx.env.DB.prepare(
        "UPDATE files SET content_type = ?, size_bytes = ?, last_replaced_at = ?, version = version + 1 WHERE project = ? AND name = ?"
      )
        .bind(contentType, sizeBytes, now, project, name)
        .run();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return errorResult({
        error: "metadata_update_failed",
        message: `Bytes were updated at ${publicUrl} but metadata sync failed. Retry to bump version and last_replaced_at.`,
        detail,
      });
    }
    return okResult({
      url: publicUrl,
      project,
      name,
      size_bytes: sizeBytes,
      content_type: contentType,
      uploaded_at: existing.uploaded_at,
      last_replaced_at: now,
      version: existing.version + 1,
    });
  }

  // New-file branch: INSERT a fresh row.
  const id = crypto.randomUUID();
  try {
    await ctx.env.DB.prepare(
      "INSERT INTO files (id, project, name, r2_key, content_type, size_bytes, public_url, uploaded_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
    )
      .bind(id, project, name, r2Key, contentType, sizeBytes, publicUrl, now)
      .run();
  } catch (e) {
    if (opts.rollbackOnInsertFailure) {
      // Best-effort R2 rollback so we don't leave an orphan object. Phase 4 A
      // (finalize) opts out of this — see the opts doc.
      try {
        await ctx.env.ASSETS.delete(r2Key);
      } catch {
        // Swallow secondary failure per A6 — the primary error is what matters.
      }
    }
    const detail = e instanceof Error ? e.message : String(e);
    return errorResult({
      error: "metadata_insert_failed",
      message: opts.rollbackOnInsertFailure
        ? `Failed to record metadata for ${r2Key}. Bytes have been removed (best-effort).`
        : `Failed to record metadata for ${r2Key}. Bytes remain at the public URL — retry cdn_finalize_upload to commit the row.`,
      detail,
    });
  }

  return okResult({
    url: publicUrl,
    project,
    name,
    size_bytes: sizeBytes,
    content_type: contentType,
    uploaded_at: now,
    last_replaced_at: null,
    version: 1,
  });
}

/**
 * Shared upload/replace handler body. Returns the same response envelope shape
 * regardless of which tool delegated here, so the connector-side contract is
 * indistinguishable.
 */
export async function performUpload(
  args: Record<string, unknown>,
  ctx: ToolContext,
  opts: PerformUploadOpts
): Promise<ToolResult> {
  // -------------------------------------------------------------------
  // 1. Input validation — fail fast before any I/O.
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

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(args.content_base64);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return errorResult({ error: "invalid_base64", message });
  }

  // The cdn_upload_file schema exposes a `replace` flag; cdn_replace_file's
  // does not. When the replace tool delegates here, we force replace=true so
  // an existing row is always treated as the overwrite target rather than a
  // collision.
  const replace = opts.requireExisting ? true : args.replace === true;

  // content_type: explicit if a non-empty string, else infer from extension.
  // Same rule for both upload and replace (Phase 2 A2).
  const contentType =
    typeof args.content_type === "string" && args.content_type.length > 0
      ? args.content_type
      : inferContentType(name);

  const r2Key = `${project}/${name}`;
  const publicUrl = `${ctx.env.PUBLIC_URL_PREFIX}/${r2Key}`;

  // -------------------------------------------------------------------
  // 2. Existence check.
  //
  // If requireExisting (replace path) and the row is missing, fail before
  // touching R2. The cdn_upload_file path treats a missing row as "new
  // upload" and proceeds to the insert branch.
  // -------------------------------------------------------------------
  const existing = await ctx.env.DB.prepare(
    "SELECT id, version, uploaded_at FROM files WHERE project = ? AND name = ?"
  )
    .bind(project, name)
    .first<ExistingFileRow>();

  if (opts.requireExisting && !existing) {
    return errorResult({
      error: "file_not_found",
      message: `File not found at ${project}/${name}. Use cdn_upload_file to create.`,
    });
  }

  if (existing && !replace) {
    return errorResult({
      error: "file_exists",
      message: `File "${project}/${name}" already exists. Pass replace: true to overwrite (or use cdn_replace_file in Phase 2+).`,
    });
  }

  const now = new Date().toISOString();

  // -------------------------------------------------------------------
  // 3. Auto-create project (no-op if it already exists).
  //
  // INSERT OR IGNORE keeps the explicit cdn_create_project path's
  // "project_exists" error meaningful. The replace path also runs this
  // — it's a cheap idempotent statement, and the project must exist
  // when the row exists anyway.
  // -------------------------------------------------------------------
  await ctx.env.DB.prepare(
    "INSERT OR IGNORE INTO projects (name, description, created_at) VALUES (?, NULL, ?)"
  )
    .bind(project, now)
    .run();

  // -------------------------------------------------------------------
  // 4. R2 PUT (bytes-first, per A6).
  //
  // Phase 4.1: also write Cache-Control. R2 echoes it back as a
  // response header on public reads, which lets Cloudflare's edge
  // make a sane caching decision instead of falling back to long
  // defaults that hold stale bytes after a replace.
  // -------------------------------------------------------------------
  await ctx.env.ASSETS.put(r2Key, bytes, {
    httpMetadata: { contentType, cacheControl: DEFAULT_CACHE_CONTROL },
  });

  // -------------------------------------------------------------------
  // 5. D1 mutate — delegate to commitFileMetadata.
  //
  // Phase 4 A1: rollback on INSERT failure is true here (we just PUT
  // those bytes, rolling back is cheap and keeps the bucket clean).
  // -------------------------------------------------------------------
  return commitFileMetadata(
    {
      project,
      name,
      r2Key,
      publicUrl,
      contentType,
      sizeBytes: bytes.length,
      now,
      existing: existing ?? null,
    },
    ctx,
    { rollbackOnInsertFailure: true }
  );
}

// -----------------------------------------------------------------------------
// cdn_delete_file — Phase 2 real handler.
//
// Flow:
//   1. Validate project + filename. Fail fast with invalid_project/invalid_name
//      before any I/O.
//   2. Look up the row in D1 by (project, name). If missing → return
//      file_not_found and do nothing.
//   3. R2 first, then D1 — same write-ordering convention as Phase 1's
//      upload path. R2's `R2Bucket.delete()` is idempotent (does NOT throw
//      on missing keys per @cloudflare/workers-types), so retries are safe.
//   4. Return { project, name, deleted_at }.
//
// Phase 2 head-session decisions:
//   A3: Skip a defensive head() call before delete. D1 is the authoritative
//       record of "what should exist." If R2 is silently missing the object,
//       the idempotent delete just succeeds anyway.
//   - Don't auto-delete the project row when its file_count drops to zero.
//     Empty projects are intentional; cleanup of empty projects would be a
//     future cdn_delete_project tool, not part of this surface.
//
// Failure modes (recovery on retry):
//   - R2 delete fails before D1 → return metadata-side error, both layers
//     still in place. User retries → R2 delete succeeds → D1 delete runs →
//     cleaned up.
//   - R2 delete succeeds, D1 delete fails → orphan row in D1. User retries
//     cdn_delete_file → row still in D1, R2 delete is idempotent on the
//     already-gone object → D1 delete retries → cleaned up.
//
// Either failure leaves the system in a state where re-running the delete
// converges to "fully cleaned up." That's the whole point of R2-first + idempotency.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import {
  errorResult,
  okResult,
  validateFileName,
  validateProjectName,
} from "../util";

const NAME = "cdn_delete_file";

interface ExistingFileRow {
  id: string;
  r2_key: string;
}

export const cdn_delete_file: Tool = {
  name: NAME,
  description:
    "Permanently delete a file from the personal CDN. Removes both the R2 object and the metadata row. The public URL will return 404 after this call. Cannot be undone.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project (folder) name containing the file.",
      },
      name: {
        type: "string",
        description: "Filename within the project.",
      },
    },
    required: ["project", "name"],
  },
  handler: async (args, ctx) => {
    // -------------------------------------------------------------------
    // 1. Input validation
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

    // -------------------------------------------------------------------
    // 2. Existence check (D1 is the source of truth)
    // -------------------------------------------------------------------
    const existing = await ctx.env.DB.prepare(
      "SELECT id, r2_key FROM files WHERE project = ? AND name = ?"
    )
      .bind(project, name)
      .first<ExistingFileRow>();

    if (!existing) {
      return errorResult({
        error: "file_not_found",
        message: `File not found at ${project}/${name}.`,
      });
    }

    // -------------------------------------------------------------------
    // 3. R2 first — idempotent on missing keys.
    // -------------------------------------------------------------------
    try {
      await ctx.env.ASSETS.delete(existing.r2_key);
    } catch (e) {
      // Surfacing the underlying error is more useful than a generic
      // message — operators can tell whether this is a transient R2
      // outage (retry will work) or a permission/binding issue.
      const detail = e instanceof Error ? e.message : String(e);
      return errorResult({
        error: "r2_delete_failed",
        message: `Failed to delete R2 object ${existing.r2_key}. The metadata row is still in place; retrying will clean up both layers.`,
        detail,
      });
    }

    // -------------------------------------------------------------------
    // 4. D1 delete. If this fails, the R2 object is already gone but the
    //    metadata row remains. Retrying cdn_delete_file is the user-visible
    //    fix — R2 delete is idempotent so the second pass cleans the row.
    // -------------------------------------------------------------------
    try {
      await ctx.env.DB.prepare(
        "DELETE FROM files WHERE project = ? AND name = ?"
      )
        .bind(project, name)
        .run();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return errorResult({
        error: "metadata_delete_failed",
        message: `R2 object ${existing.r2_key} was deleted but metadata removal failed. Retry cdn_delete_file to clean up.`,
        detail,
      });
    }

    return okResult({
      project,
      name,
      deleted_at: new Date().toISOString(),
    });
  },
};

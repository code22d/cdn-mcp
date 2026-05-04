// -----------------------------------------------------------------------------
// cdn_get_file — Phase 3 real handler.
//
// Single-row D1 lookup by (project, name). Returns the same per-file shape as
// cdn_list_files (so a single-row read and a list-row read are byte-compatible
// for any consumer that wants to handle them uniformly). No bytes — bytes live
// at the public URL.
//
// Phase 3 head-session decisions:
//   A2 (Phase 3): cdn_get_file is the permissive getter. Any miss — whether
//       the project doesn't exist or the file doesn't exist within it — is
//       reported as `file_not_found` from a single (project, name) SELECT on
//       the files table. We deliberately do NOT consult the projects table
//       to differentiate. The caller asked "is THIS specific item there?";
//       file_not_found covers every reason the answer is no, and saves a
//       round-trip. Counterpart rule (A3) is that cdn_get_stats({project})
//       IS strict — different question, different answer.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import {
  errorResult,
  okResult,
  validateFileName,
  validateProjectName,
} from "../util";

const NAME = "cdn_get_file";

interface FileRow {
  id: string;
  project: string;
  name: string;
  public_url: string;
  content_type: string | null;
  size_bytes: number;
  uploaded_at: string;
  last_replaced_at: string | null;
  version: number;
}

export const cdn_get_file: Tool = {
  name: NAME,
  description:
    "Get the metadata for one file by (project, name). Returns the public URL, size, content-type, version, and upload/replace timestamps. Does NOT return the file bytes — fetch the public URL for those.",
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

    // -------------------------------------------------------------------
    // 2. Single-row lookup. Permissive — see Phase 3 A2 above.
    //
    // Column list mirrors cdn_list_files's SELECT so the response shape
    // is verbatim identical to a single entry in cdn_list_files.files[].
    // -------------------------------------------------------------------
    const row = await ctx.env.DB.prepare(
      "SELECT id, project, name, public_url, content_type, size_bytes, uploaded_at, last_replaced_at, version FROM files WHERE project = ? AND name = ?"
    )
      .bind(project, name)
      .first<FileRow>();

    if (!row) {
      return errorResult({
        error: "file_not_found",
        message: `File not found at ${project}/${name}.`,
      });
    }

    return okResult({
      name: row.name,
      project: row.project,
      url: row.public_url,
      size_bytes: row.size_bytes,
      content_type: row.content_type,
      uploaded_at: row.uploaded_at,
      last_replaced_at: row.last_replaced_at,
      version: row.version,
    });
  },
};

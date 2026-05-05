// -----------------------------------------------------------------------------
// cdn_list_files — Phase 1 real handler.
//
// Sort order (A3): ORDER BY uploaded_at DESC, id ASC.
//   - Newest-first is the natural UX for a CDN listing.
//   - id ASC is the stable tiebreaker for rows uploaded in the same ISO-8601
//     second (D1's strftime resolution + bulk inserts will create ties).
//
// Pagination (A2): cursor = base64(JSON.stringify({ uploaded_at, id })).
//   - Opaque to callers, easy to evolve server-side.
//   - We fetch limit+1 rows; if we got more than `limit`, there's another page
//     and the next_cursor points at the last row we returned.
//
// Optional `project` filter scopes the listing to one project. Filenames + the
// project filter both run through the same regex/length validators we use on
// upload — paginated reads of an obviously-bogus project should fail fast,
// not return an empty list and look like the project just doesn't exist.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import {
  decodeCursor,
  encodeCursor,
  errorResult,
  okResult,
  validateProjectName,
} from "../util";

const NAME = "cdn_list_files";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

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

interface FilesCursor {
  uploaded_at: string;
  id: string;
}

export const cdn_list_files: Tool = {
  name: NAME,
  description:
    "List files in a project (or globally if `project` omitted). Sorted by `uploaded_at` DESC then `id` ASC (newest first; UUID tiebreak for stability). Cursor-paginated — pass `next_cursor` from a prior response to get the next page. Each entry: name, project, public URL, size_bytes, content_type, uploaded_at, last_replaced_at, version.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description:
          "Optional project (folder) name to scope the listing. Omit for a global listing.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of files to return (1–1000).",
        minimum: 1,
        maximum: 1000,
        default: 100,
      },
      cursor: {
        type: "string",
        description:
          "Opaque pagination cursor returned by a prior call. Omit for the first page.",
      },
    },
  },
  handler: async (args, ctx) => {
    // -------------------------------------------------------------------
    // limit (default 100, clamp to [1, 1000])
    // -------------------------------------------------------------------
    let limit = DEFAULT_LIMIT;
    if (args.limit !== undefined) {
      if (
        typeof args.limit !== "number" ||
        !Number.isInteger(args.limit) ||
        args.limit < 1 ||
        args.limit > MAX_LIMIT
      ) {
        return errorResult({
          error: "invalid_limit",
          message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
        });
      }
      limit = args.limit;
    }

    // -------------------------------------------------------------------
    // cursor (opaque base64-of-JSON; null on first page)
    // -------------------------------------------------------------------
    let cursorData: FilesCursor | null = null;
    if (args.cursor !== undefined && args.cursor !== null) {
      cursorData = decodeCursor<FilesCursor>(args.cursor);
      if (
        cursorData === null ||
        typeof cursorData.uploaded_at !== "string" ||
        typeof cursorData.id !== "string"
      ) {
        return errorResult({
          error: "invalid_cursor",
          message: "cursor is malformed or expired",
        });
      }
    }

    // -------------------------------------------------------------------
    // project filter
    // -------------------------------------------------------------------
    let projectFilter: string | null = null;
    if (args.project !== undefined && args.project !== null) {
      const projectErr = validateProjectName(args.project);
      if (projectErr) {
        return errorResult({ error: "invalid_project", message: projectErr });
      }
      projectFilter = args.project as string;
    }

    // -------------------------------------------------------------------
    // Build SQL
    //
    // Cursor predicate for DESC-then-ASC ordering:
    //   (uploaded_at, id) is "after" (cur.uploaded_at, cur.id) when
    //     uploaded_at <  cur.uploaded_at, OR
    //     uploaded_at == cur.uploaded_at AND id > cur.id
    //
    // Fetch limit+1 to detect "is there a next page".
    // -------------------------------------------------------------------
    const conditions: string[] = [];
    const binds: unknown[] = [];

    if (projectFilter !== null) {
      conditions.push("project = ?");
      binds.push(projectFilter);
    }
    if (cursorData !== null) {
      conditions.push("(uploaded_at < ? OR (uploaded_at = ? AND id > ?))");
      binds.push(cursorData.uploaded_at, cursorData.uploaded_at, cursorData.id);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `SELECT id, project, name, public_url, content_type, size_bytes, uploaded_at, last_replaced_at, version FROM files ${whereClause} ORDER BY uploaded_at DESC, id ASC LIMIT ?`;
    binds.push(limit + 1);

    const result = await ctx.env.DB.prepare(sql)
      .bind(...binds)
      .all<FileRow>();
    const rows: FileRow[] = result.results ?? [];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const last = page.length > 0 ? page[page.length - 1] : undefined;
    const next_cursor =
      hasMore && last !== undefined
        ? encodeCursor({ uploaded_at: last.uploaded_at, id: last.id })
        : null;

    const files = page.map((r) => ({
      name: r.name,
      project: r.project,
      url: r.public_url,
      size_bytes: r.size_bytes,
      content_type: r.content_type,
      uploaded_at: r.uploaded_at,
      last_replaced_at: r.last_replaced_at,
      version: r.version,
    }));

    return okResult({ files, next_cursor });
  },
};

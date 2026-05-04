// -----------------------------------------------------------------------------
// cdn_list_projects — Phase 1 real handler.
//
// Returns one row per project in `projects`, joined to `files` to compute
// COUNT(*) and SUM(size_bytes). LEFT JOIN so freshly-created empty projects
// still appear with file_count: 0 and total_size_bytes: 0.
//
// Sort order: ORDER BY p.name ASC. Stable, predictable, matches the SQL
// example in the Phase 1 prompt verbatim.
//
// Pagination: cursor = base64(JSON.stringify({ lastName })). Same shape
// pattern as cdn_list_files for consistency. Fetch limit+1 to detect
// "another page".
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import {
  decodeCursor,
  encodeCursor,
  errorResult,
  okResult,
} from "../util";

const NAME = "cdn_list_projects";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

interface ProjectRow {
  name: string;
  description: string | null;
  created_at: string;
  file_count: number;
  total_size_bytes: number;
}

interface ProjectsCursor {
  lastName: string;
}

export const cdn_list_projects: Tool = {
  name: NAME,
  description:
    "List all known projects (folders) on the personal CDN. Each entry includes the project name, optional description, file count, and total size in bytes. Supports cursor pagination.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "Maximum number of projects to return (1–1000).",
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
    // cursor
    // -------------------------------------------------------------------
    let cursorData: ProjectsCursor | null = null;
    if (args.cursor !== undefined && args.cursor !== null) {
      cursorData = decodeCursor<ProjectsCursor>(args.cursor);
      if (cursorData === null || typeof cursorData.lastName !== "string") {
        return errorResult({
          error: "invalid_cursor",
          message: "cursor is malformed or expired",
        });
      }
    }

    // -------------------------------------------------------------------
    // SQL — LEFT JOIN keeps empty projects visible.
    // -------------------------------------------------------------------
    const binds: unknown[] = [];
    let whereClause = "";
    if (cursorData !== null) {
      whereClause = "WHERE p.name > ?";
      binds.push(cursorData.lastName);
    }

    const sql = `
      SELECT p.name AS name,
             p.description AS description,
             p.created_at AS created_at,
             COUNT(f.id) AS file_count,
             COALESCE(SUM(f.size_bytes), 0) AS total_size_bytes
      FROM projects p
      LEFT JOIN files f ON f.project = p.name
      ${whereClause}
      GROUP BY p.name
      ORDER BY p.name ASC
      LIMIT ?
    `;
    binds.push(limit + 1);

    const result = await ctx.env.DB.prepare(sql)
      .bind(...binds)
      .all<ProjectRow>();
    const rows: ProjectRow[] = result.results ?? [];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const last = page.length > 0 ? page[page.length - 1] : undefined;
    const next_cursor =
      hasMore && last !== undefined
        ? encodeCursor({ lastName: last.name })
        : null;

    const projects = page.map((r) => ({
      name: r.name,
      description: r.description,
      file_count: r.file_count,
      total_size_bytes: r.total_size_bytes,
      created_at: r.created_at,
    }));

    return okResult({ projects, next_cursor });
  },
};

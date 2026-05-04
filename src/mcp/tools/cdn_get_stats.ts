// -----------------------------------------------------------------------------
// cdn_get_stats — Phase 3 real handler.
//
// Two modes:
//
//   A. Global (project omitted) — totals across the whole CDN plus a
//      per-project breakdown. project_count is derived from the files table
//      (projects with ≥ 1 file) so it ALWAYS equals projects.length —
//      decision A1 (Phase 3). Empty projects in the projects table do NOT
//      count; callers who want the count of all project records (including
//      empty ones) should use cdn_list_projects and read its array length.
//
//   B. Scoped (project provided) — totals for a single project. STRICT: a
//      never-existed project name returns project_not_found, NOT silent
//      zeros. Decision A3 (Phase 3). The asymmetry with cdn_get_file's
//      permissive A2 rule is intentional:
//
//          cdn_get_file       ("is THIS specific item there?")
//            → file_not_found covers every reason the answer is no.
//          cdn_get_stats({project}) ("what's the SCOPE of this container?")
//            → silently returning zeros for a non-existent scope hides typos
//              and looks like an empty project. Strict mode makes the
//              no-such-scope case loud.
//
// Empty-state vs not-found:
//   - Mode A on an empty bucket: { project_count: 0, file_count: 0,
//     total_size_bytes: 0, projects: [] } — success, not error.
//   - Mode B on an existing-but-empty project: { project, file_count: 0,
//     total_size_bytes: 0 } — success, not error.
//   - Mode B on a never-existed project: isError + project_not_found.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import { errorResult, okResult, validateProjectName } from "../util";

const NAME = "cdn_get_stats";

interface GlobalTotalsRow {
  project_count: number;
  file_count: number;
  total_size_bytes: number;
}

interface ProjectBreakdownRow {
  project: string;
  file_count: number;
  total_size_bytes: number;
}

interface ScopedTotalsRow {
  file_count: number;
  total_size_bytes: number;
}

export const cdn_get_stats: Tool = {
  name: NAME,
  description:
    "Get aggregate storage statistics for the personal CDN. Without `project`, returns global totals (file count, total bytes, project count) plus per-project breakdown. With `project`, returns just that project's totals.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description:
          "Optional project (folder) name to scope the stats. Omit for global stats with per-project breakdown.",
      },
    },
  },
  handler: async (args, ctx) => {
    // -------------------------------------------------------------------
    // Mode B — scoped (project provided)
    // -------------------------------------------------------------------
    if (args.project !== undefined && args.project !== null) {
      const projectErr = validateProjectName(args.project);
      if (projectErr) {
        return errorResult({ error: "invalid_project", message: projectErr });
      }
      const project = args.project as string;

      // Strict existence check (A3) — separates "project doesn't exist"
      // from "project exists but is empty". The files-table aggregate
      // can't tell those apart on its own (both produce zeros).
      const exists = await ctx.env.DB.prepare(
        "SELECT 1 AS one FROM projects WHERE name = ?"
      )
        .bind(project)
        .first<{ one: number }>();

      if (!exists) {
        return errorResult({
          error: "project_not_found",
          message: `Project '${project}' does not exist.`,
        });
      }

      const totals = await ctx.env.DB.prepare(
        "SELECT COUNT(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS total_size_bytes FROM files WHERE project = ?"
      )
        .bind(project)
        .first<ScopedTotalsRow>();

      // COUNT/SUM always return one row even on empty input — but stay
      // defensive in case a future driver change surprises us.
      return okResult({
        project,
        file_count: totals?.file_count ?? 0,
        total_size_bytes: totals?.total_size_bytes ?? 0,
      });
    }

    // -------------------------------------------------------------------
    // Mode A — global (no project)
    // -------------------------------------------------------------------
    const totals = await ctx.env.DB.prepare(
      "SELECT COUNT(DISTINCT project) AS project_count, COUNT(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS total_size_bytes FROM files"
    ).first<GlobalTotalsRow>();

    const breakdown = await ctx.env.DB.prepare(
      "SELECT project, COUNT(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS total_size_bytes FROM files GROUP BY project ORDER BY project ASC"
    ).all<ProjectBreakdownRow>();

    const projects = (breakdown.results ?? []).map((r) => ({
      name: r.project,
      file_count: r.file_count,
      total_size_bytes: r.total_size_bytes,
    }));

    return okResult({
      project_count: totals?.project_count ?? 0,
      file_count: totals?.file_count ?? 0,
      total_size_bytes: totals?.total_size_bytes ?? 0,
      projects,
    });
  },
};

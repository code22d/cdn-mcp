// -----------------------------------------------------------------------------
// cdn_create_project — Phase 1 real handler.
//
// Pre-create an empty project. Optional, since cdn_upload_file auto-creates
// projects via INSERT OR IGNORE. Use this when you want to reserve a name
// or attach a description before any files exist.
//
// Error contract:
//   - invalid_name: project name fails the regex/length check
//   - project_exists: a project with this name is already in the table
//
// Schema is frozen (Phase 0 registered) — we only swap the handler.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";
import { errorResult, okResult, validateProjectName } from "../util";

const NAME = "cdn_create_project";

export const cdn_create_project: Tool = {
  name: NAME,
  description:
    "Pre-create an empty project (folder) on the personal CDN. Optional — projects are also auto-created on first upload via cdn_upload_file. Use this when you want to attach a description, or to reserve a project name before any files exist.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Project name. Becomes the first segment of public URLs for files in this project (e.g. https://cdn.22d.app/<name>/...).",
      },
      description: {
        type: "string",
        description:
          "Optional human-readable description of the project's purpose.",
      },
    },
    required: ["name"],
  },
  handler: async (args, ctx) => {
    const name = args.name;
    const nameErr = validateProjectName(name);
    if (nameErr) {
      return errorResult({ error: "invalid_name", message: nameErr });
    }
    // Cast is safe — validateProjectName already rejected non-strings.
    const projectName = name as string;

    const description =
      typeof args.description === "string" && args.description.length > 0
        ? args.description
        : null;

    // Existence check — distinct from cdn_upload_file's INSERT OR IGNORE so
    // the explicit-create path returns a clear "already exists" signal.
    const existing = await ctx.env.DB.prepare(
      "SELECT name FROM projects WHERE name = ?"
    )
      .bind(projectName)
      .first<{ name: string }>();
    if (existing) {
      return errorResult({
        error: "project_exists",
        message: `Project "${projectName}" already exists.`,
      });
    }

    const created_at = new Date().toISOString();
    await ctx.env.DB.prepare(
      "INSERT INTO projects (name, description, created_at) VALUES (?, ?, ?)"
    )
      .bind(projectName, description, created_at)
      .run();

    return okResult({
      name: projectName,
      description,
      created_at,
    });
  },
};

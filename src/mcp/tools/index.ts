// -----------------------------------------------------------------------------
// Tool registry for cdn-mcp.
//
// Every tool is imported and added to the TOOLS array. The dispatcher in
// ../dispatch.ts iterates this array for tools/list and tools/call.
//
// Tool surface is FROZEN as of Phase 0. New tool ideas must be proposed to
// the head session, added to the Build Plan's Tool Surface table, registered
// here as a stub, THEN implemented. Never silently add or rename a tool —
// it breaks the connector-side contract that lets phases ship without
// connector migrations.
//
// Phase 5.0a (2026-05-04) deliberately extended the surface from 12 to 13
// tools by adding `cdn_help` — a meta tool that returns the Usage Guide.
// This was a planned, head-session-approved addition (Build Plan Meta Tools
// table), not surface drift.
// -----------------------------------------------------------------------------

import type { Tool } from "../../types";

// v1 tools (Phase 1–3 swap real handlers in)
import { cdn_upload_file } from "./cdn_upload_file";
import { cdn_replace_file } from "./cdn_replace_file";
import { cdn_list_files } from "./cdn_list_files";
import { cdn_list_projects } from "./cdn_list_projects";
import { cdn_get_file } from "./cdn_get_file";
import { cdn_delete_file } from "./cdn_delete_file";
import { cdn_get_stats } from "./cdn_get_stats";
import { cdn_create_project } from "./cdn_create_project";

// Phase 4+ tools (stubs from Day 1)
import { cdn_signed_upload_url } from "./cdn_signed_upload_url";
import { cdn_finalize_upload } from "./cdn_finalize_upload";
import { cdn_rename_file } from "./cdn_rename_file";
import { cdn_set_cache_headers } from "./cdn_set_cache_headers";

// Meta tools (Phase 5.0a+)
import { cdn_help } from "./cdn_help";

export const TOOLS: Tool[] = [
  // v1
  cdn_upload_file,
  cdn_replace_file,
  cdn_list_files,
  cdn_list_projects,
  cdn_get_file,
  cdn_delete_file,
  cdn_get_stats,
  cdn_create_project,
  // Phase 4+
  cdn_signed_upload_url,
  cdn_finalize_upload,
  cdn_rename_file,
  cdn_set_cache_headers,
  // Meta
  cdn_help,
];

// Module-load guard: fail loud if two tools accidentally share a name.
// (This runs once on first import — i.e. on every cold start of the Worker.)
{
  const seen = new Set<string>();
  for (const t of TOOLS) {
    if (seen.has(t.name)) {
      throw new Error(`Duplicate tool name in registry: ${t.name}`);
    }
    seen.add(t.name);
  }
}

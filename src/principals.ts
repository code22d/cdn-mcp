// -----------------------------------------------------------------------------
// Per-project principals (Phase 12).
//
// The MCP_PRINCIPALS secret is a JSON map of gateway token → principal:
//
//   { "<gateway-token>": { "project": "acme-site" },
//     "<other-token>":   { "project": "*" } }
//
// A principal pinned to a project can only ever touch that project: every
// tool's caller-supplied `project` argument is OVERRIDDEN (not validated —
// overridden) with the principal's project before the handler runs, and
// cdn_list_projects / cdn_get_stats collapse to that project's slice.
//
// The legacy MCP_AUTH_TOKEN secret keeps working and maps to "*" (all
// projects), as do OAuth Bearer tokens (the OAuth flow is the owner's
// single-user connector). Rotation for a tenant = add a second map entry
// with the same { project }, roll the client, remove the old entry.
//
// Parsing is fail-closed: malformed JSON or a non-object root yields an
// EMPTY map (auth degrades to 404, never a crash); malformed entries are
// skipped individually.
// -----------------------------------------------------------------------------

import type { Env } from "./types";
import { timingSafeEqualStr } from "./oauth/confidential";

/** Sentinel project meaning "all projects" (the owner principal). */
export const ALL_PROJECTS = "*";

export interface Principal {
  /** Project this caller is pinned to, or "*" for all projects. */
  project: string;
}

export const OWNER_PRINCIPAL: Principal = { project: ALL_PROJECTS };

/** Parse the MCP_PRINCIPALS JSON map. Never throws. */
export function parsePrincipals(raw: string | undefined): Map<string, Principal> {
  const out = new Map<string, Principal>();
  if (!raw) return out;

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return out;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return out;

  for (const [token, value] of Object.entries(doc as Record<string, unknown>)) {
    if (token.trim().length === 0) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const project = (value as Record<string, unknown>).project;
    if (typeof project !== "string" || project.trim().length === 0) continue;
    out.set(token, { project: project.trim() });
  }
  return out;
}

/**
 * Resolve a legacy-path URL token (/mcp/<token>) to its principal.
 *
 * Order: the long-standing MCP_AUTH_TOKEN (owner, all projects) first, then
 * the MCP_PRINCIPALS map. Every candidate is compared with
 * timingSafeEqualStr and the scan never exits early on a match, so timing
 * doesn't reveal which (if any) entry matched. Returns null for an unknown
 * token — the router keeps answering 404, indistinguishable from "no MCP
 * server here".
 */
export function resolvePathToken(urlToken: string, env: Env): Principal | null {
  let matched: Principal | null = null;

  if (env.MCP_AUTH_TOKEN && timingSafeEqualStr(urlToken, env.MCP_AUTH_TOKEN)) {
    matched = OWNER_PRINCIPAL;
  }

  for (const [candidate, principal] of parsePrincipals(env.MCP_PRINCIPALS)) {
    if (timingSafeEqualStr(urlToken, candidate) && matched === null) {
      matched = principal;
    }
  }

  return matched;
}

/**
 * Force a scoped principal's project onto a tool call's arguments.
 *
 * - Owner ("*") principals: arguments pass through untouched.
 * - cdn_create_project addresses projects via `name` → forced.
 * - cdn_help takes no project; cdn_list_projects has no project argument and
 *   scopes inside its handler (it reads ctx.principal) → left alone.
 * - Everything else takes `project` → forced. Overriding (rather than
 *   validating) means a caller-supplied project can never influence the
 *   target, and tools where project is optional (cdn_list_files,
 *   cdn_get_stats) collapse from "global" to "my project" automatically.
 */
export function applyPrincipal(
  toolName: string,
  args: Record<string, unknown>,
  principal: Principal
): Record<string, unknown> {
  if (principal.project === ALL_PROJECTS) return args;
  if (toolName === "cdn_help" || toolName === "cdn_list_projects") return args;
  if (toolName === "cdn_create_project") return { ...args, name: principal.project };
  return { ...args, project: principal.project };
}

// -----------------------------------------------------------------------------
// cdn-mcp Worker entry.
//
// Routes:
//   OPTIONS *                                  → 200 + CORS headers (preflight)
//   GET     /health                            → 200 JSON { status: "ok", ... }
//
//   Phase 11 — OAuth 2.1 + Streamable HTTP for claude.ai Custom Connector:
//     GET   /.well-known/oauth-protected-resource     → RFC 9728 metadata
//     GET   /.well-known/oauth-authorization-server   → RFC 8414 metadata
//     POST  /register                                 → RFC 7591 DCR
//     GET   /authorize                                → OAuth authorize (auto-approve)
//     POST  /token                                    → OAuth token (auth_code + refresh)
//     POST  /mcp                                      → MCP JSON-RPC (Bearer)
//     GET   /mcp                                      → SSE event stream (Bearer)
//     DELETE /mcp                                     → 204 session terminate
//
//   Legacy — preserved for the Cowork plugin (do NOT remove):
//     POST  /mcp/<token>    → MCP JSON-RPC dispatcher (token compared against
//                              env.MCP_AUTH_TOKEN; mismatch → 404)
//   *                       → 404 + CORS
//
// Every response — including 404 and errors — includes CORS headers.
// Lessons-page rule: missing CORS is the most common silent failure for
// Custom Connectors.
// -----------------------------------------------------------------------------

import { corsResponse, jsonResponse } from "./cors";
import { handleMcp } from "./mcp/dispatch";
import { resolvePathToken } from "./principals";
import { handleStreamable } from "./mcp/streamable";
import { handleAuthorize } from "./oauth/authorize";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "./oauth/metadata";
import { handleRegister } from "./oauth/register";
import { handleToken } from "./oauth/token";
import type { Env } from "./types";

// Re-export the registry so module-load guards (duplicate names) run on cold
// start, and so test/sanity.ts can import the same TOOLS array.
export { TOOLS } from "./mcp/tools/index";

const VERSION = "0.1.0-phase11.2";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight — must succeed for any cross-origin caller.
    if (request.method === "OPTIONS") {
      return corsResponse(null, { status: 200 });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Health check — public, no auth.
    if (path === "/health" && method === "GET") {
      return jsonResponse({
        status: "ok",
        service: "cdn-mcp",
        version: VERSION,
        time: new Date().toISOString(),
      });
    }

    // -- OAuth discovery + DCR + auth flow (Phase 11) -------------------
    if (path === "/.well-known/oauth-protected-resource" && method === "GET") {
      return protectedResourceMetadata(request);
    }
    if (path === "/.well-known/oauth-authorization-server" && method === "GET") {
      return authorizationServerMetadata(request, env);
    }
    if (path === "/register") {
      return handleRegister(request, env);
    }
    if (path === "/authorize") {
      return handleAuthorize(request, env);
    }
    if (path === "/token") {
      return handleToken(request, env);
    }

    // -- Streamable HTTP /mcp (Bearer auth) ------------------------------
    if (path === "/mcp") {
      return handleStreamable(request, env);
    }

    // -- Legacy /mcp/<token> (Cowork plugin + per-project principals) ----
    if (path.startsWith("/mcp/")) {
      const urlToken = path.slice("/mcp/".length);
      // Phase 12: the token is either MCP_AUTH_TOKEN (owner, all projects)
      // or an entry in the MCP_PRINCIPALS map (pinned to one project). All
      // candidates are compared in constant time; unknown tokens keep
      // getting the indistinguishable 404.
      const principal = resolvePathToken(urlToken, env);
      if (principal === null) {
        return corsResponse("Not Found", { status: 404 });
      }
      return handleMcp(request, env, principal);
    }

    return corsResponse("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

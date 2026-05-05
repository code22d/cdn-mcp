// -----------------------------------------------------------------------------
// cdn-mcp Worker entry.
//
// Routes:
//   OPTIONS *               → 200 + CORS headers (preflight)
//   GET     /health         → 200 JSON { status: "ok", ... }
//   POST    /mcp/<token>    → MCP JSON-RPC dispatcher (token compared against
//                              env.MCP_AUTH_TOKEN; mismatch → 404 to avoid
//                              leaking the existence of an MCP endpoint)
//   *                       → 404 + CORS
//
// Every response — including 404 and errors — includes CORS headers.
// Lessons-page rule: missing CORS is the most common silent failure for
// Custom Connectors.
// -----------------------------------------------------------------------------

import { corsResponse, jsonResponse } from "./cors";
import { handleMcp } from "./mcp/dispatch";
import type { Env } from "./types";

// Re-export the registry so module-load guards (duplicate names) run on cold
// start, and so test/sanity.ts can import the same TOOLS array.
export { TOOLS } from "./mcp/tools/index";

const VERSION = "0.1.0-phase5a";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight — must succeed for any cross-origin caller.
    if (request.method === "OPTIONS") {
      return corsResponse(null, { status: 200 });
    }

    const url = new URL(request.url);

    // Health check — public, no auth.
    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({
        status: "ok",
        service: "cdn-mcp",
        version: VERSION,
        time: new Date().toISOString(),
      });
    }

    // MCP endpoint — token in URL path acts as the shared secret.
    // (Claude's Custom Connector UI has no Authorization-header field, so
    // the token MUST live in the path. See the Custom MCP Connection guide.)
    if (url.pathname.startsWith("/mcp/")) {
      const urlToken = url.pathname.slice("/mcp/".length);
      // Constant-time compare not strictly necessary here — a 404 leaks no
      // timing info beyond "this URL doesn't exist" — but we keep the auth
      // failure indistinguishable from "no MCP server here" by returning 404.
      if (!env.MCP_AUTH_TOKEN || urlToken !== env.MCP_AUTH_TOKEN) {
        return corsResponse("Not Found", { status: 404 });
      }
      return handleMcp(request, env);
    }

    return corsResponse("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

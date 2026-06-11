// -----------------------------------------------------------------------------
// src/oauth/metadata.ts — Protected Resource Metadata (RFC 9728) and
// Authorization Server Metadata (RFC 8414) endpoints.
//
// claude.ai's Custom Connector flow hits /.well-known/oauth-protected-resource
// when it sees a 401 with WWW-Authenticate: Bearer resource_metadata=<url>, and
// from there fetches /.well-known/oauth-authorization-server to discover the
// /register, /authorize, and /token endpoints. Both responses are static JSON;
// the only dynamic piece is the issuer URL, which we derive from the request
// Host header so dev (workers.dev) and prod (cdn-mcp.22d.app) share code.
// -----------------------------------------------------------------------------

import { jsonResponse } from "../cors";
import { confidentialClientConfigured } from "./confidential";
import type { Env } from "../types";

/**
 * Derive the issuer URL from an incoming request. Honors Cloudflare's
 * X-Forwarded-Proto if present (so dev under wrangler dev http://localhost...
 * still yields a usable issuer for local testing).
 */
export function issuerFromRequest(request: Request): string {
  const url = new URL(request.url);
  // url.origin already includes scheme + host. Cloudflare always serves HTTPS
  // in production; in `wrangler dev` it may be http://localhost.
  return url.origin;
}

export function protectedResourceMetadata(request: Request): Response {
  const issuer = issuerFromRequest(request);
  return jsonResponse({
    resource: issuer,
    authorization_servers: [issuer],
    scopes_supported: ["cdn:full"],
    bearer_methods_supported: ["header"],
    resource_name: "cdn-mcp",
    resource_documentation: "https://github.com/code22d/cdn-mcp",
  });
}

export function authorizationServerMetadata(request: Request, env: Env): Response {
  const issuer = issuerFromRequest(request);
  // Phase 11.1 — in confidential mode /token requires client credentials, so
  // advertise the Basic/post methods instead of "none". registration_endpoint
  // stays listed: /register answers 401 registration_not_supported, which
  // claude.ai treats as "use the credentials from Advanced settings".
  const confidential = confidentialClientConfigured(env);
  return jsonResponse({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: confidential
      ? ["client_secret_basic", "client_secret_post"]
      : ["none"],
    scopes_supported: ["cdn:full"],
    // RFC 8414 strongly recommends explicit revocation/introspection
    // endpoints; we don't support them in v1. Omitting the keys means
    // "not supported" — clients tolerate this.
  });
}

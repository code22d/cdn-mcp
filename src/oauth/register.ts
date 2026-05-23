// -----------------------------------------------------------------------------
// src/oauth/register.ts — RFC 7591 Dynamic Client Registration endpoint.
//
// claude.ai discovers this via the registration_endpoint field of the
// authorization-server metadata, then POSTs its own redirect_uri + client_name
// to obtain a client_id. We do NOT issue a client_secret — claude.ai is a
// public client (PKCE-only).
//
// Redirect-URI allowlist:
//   Only https://claude.ai/api/mcp/auth_callback is accepted. This is the
//   canonical Anthropic callback for Custom Connectors across web, desktop,
//   mobile and the Cowork plugin. Restricting redirect_uri here limits the
//   blast radius of /authorize — if a request to /authorize used some other
//   client_id's redirect_uri, the auth code couldn't be redirected to a
//   third-party-controlled URL.
// -----------------------------------------------------------------------------

import { jsonResponse } from "../cors";
import type { Env } from "../types";

const ALLOWED_REDIRECT_URIS = new Set<string>([
  "https://claude.ai/api/mcp/auth_callback",
]);

interface DcrRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
  // Anything else is accepted but stored verbatim in client_metadata for audit.
  [k: string]: unknown;
}

export async function handleRegister(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError(405, "method_not_allowed", "POST required");
  }

  let body: DcrRequest;
  try {
    body = (await request.json()) as DcrRequest;
  } catch {
    return jsonError(400, "invalid_client_metadata", "Body is not valid JSON");
  }

  // redirect_uris: required, must be a non-empty array of allowlisted URLs.
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return jsonError(
      400,
      "invalid_redirect_uri",
      "redirect_uris must be a non-empty array of strings"
    );
  }
  const redirects = body.redirect_uris as unknown[];
  for (const r of redirects) {
    if (typeof r !== "string" || !ALLOWED_REDIRECT_URIS.has(r)) {
      return jsonError(
        400,
        "invalid_redirect_uri",
        `redirect_uri "${String(r)}" is not on the allowlist`
      );
    }
  }
  const redirectUris = redirects as string[];

  const clientName =
    typeof body.client_name === "string" ? body.client_name : "unnamed-client";
  const clientId = randomUuid();
  const registeredAt = new Date().toISOString();

  try {
    await env.DB.prepare(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, client_metadata, registered_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(
        clientId,
        clientName,
        JSON.stringify(redirectUris),
        JSON.stringify(body),
        registeredAt
      )
      .run();
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return jsonError(500, "registration_failed", message);
  }

  // RFC 7591 §3.2.1 — registration response. issued_at + client_id are the
  // only required fields; we include the echoed metadata for transparency.
  return jsonResponse(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.parse(registeredAt) / 1000),
      redirect_uris: redirectUris,
      client_name: clientName,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "cdn:full",
    },
    { status: 201 }
  );
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function jsonError(status: number, error: string, error_description: string): Response {
  return jsonResponse({ error, error_description }, { status });
}

function randomUuid(): string {
  // crypto.randomUUID() exists in both Workers and Node 20+. No fallback path.
  return crypto.randomUUID();
}

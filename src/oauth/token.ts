// -----------------------------------------------------------------------------
// src/oauth/token.ts — OAuth 2.1 token endpoint.
//
// Two grant types:
//   authorization_code  → exchange a one-time auth code (issued by /authorize)
//                         for an access+refresh token pair. PKCE verifier is
//                         required and checked against the stored S256
//                         challenge.
//   refresh_token       → rotate a refresh token for a fresh access+refresh
//                         pair. Verifies the refresh JWT signature + expiry.
//
// Request body: claude.ai sends application/x-www-form-urlencoded per RFC
// 6749 §3.2. We also accept JSON for ergonomic curl-based testing.
// -----------------------------------------------------------------------------

import { jsonResponse, corsResponse } from "../cors";
import { issuerFromRequest } from "./metadata";
import { issueTokenPair, verifyJwt, type RefreshTokenPayload } from "./jwt";
import { requireSigningKey } from "./signing-key";
import type { Env } from "../types";

interface AuthCodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  expires_at: string;
  used: number;
}

export async function handleToken(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError(405, "invalid_request", "POST required");
  }

  const signingKey = requireSigningKey(env);
  if (signingKey instanceof Response) return signingKey;

  const params = await readTokenParams(request);
  if (params instanceof Response) return params;

  const grantType = params.get("grant_type");
  if (grantType === "authorization_code") {
    return handleAuthorizationCode(params, env, signingKey, issuerFromRequest(request));
  }
  if (grantType === "refresh_token") {
    return handleRefresh(params, env, signingKey, issuerFromRequest(request));
  }
  return jsonError(400, "unsupported_grant_type", `grant_type "${String(grantType)}" not supported`);
}

// -----------------------------------------------------------------------------
// authorization_code grant
// -----------------------------------------------------------------------------

async function handleAuthorizationCode(
  params: URLSearchParams,
  env: Env,
  signingKey: string,
  issuer: string
): Promise<Response> {
  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const clientId = params.get("client_id");
  const codeVerifier = params.get("code_verifier");

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return jsonError(
      400,
      "invalid_request",
      "code, redirect_uri, client_id, and code_verifier are required"
    );
  }

  const row = await env.DB.prepare(
    "SELECT code, client_id, redirect_uri, code_challenge, scope, expires_at, used FROM oauth_auth_codes WHERE code = ?"
  )
    .bind(code)
    .first<AuthCodeRow>();

  if (!row) {
    return jsonError(400, "invalid_grant", "auth code not found");
  }
  if (row.used !== 0) {
    return jsonError(400, "invalid_grant", "auth code already used");
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    return jsonError(400, "invalid_grant", "auth code expired");
  }
  if (row.client_id !== clientId) {
    return jsonError(400, "invalid_grant", "client_id mismatch");
  }
  if (row.redirect_uri !== redirectUri) {
    return jsonError(400, "invalid_grant", "redirect_uri mismatch");
  }

  // PKCE — S256(code_verifier) must equal stored code_challenge.
  const computed = await s256Base64Url(codeVerifier);
  if (computed !== row.code_challenge) {
    return jsonError(400, "invalid_grant", "code_verifier does not match code_challenge");
  }

  // Mark used. We do this before issuing the token so a transient failure on
  // the token-mint path can't be retried with the same code.
  try {
    await env.DB.prepare("UPDATE oauth_auth_codes SET used = 1 WHERE code = ?")
      .bind(code)
      .run();
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return jsonError(500, "server_error", `Failed to mark code used: ${message}`);
  }

  const tokens = await issueTokenPair({ issuer, signingKey });
  return jsonResponse({
    ...tokens,
    token_type: "Bearer",
    scope: row.scope,
  });
}

// -----------------------------------------------------------------------------
// refresh_token grant
// -----------------------------------------------------------------------------

async function handleRefresh(
  params: URLSearchParams,
  env: Env,
  signingKey: string,
  issuer: string
): Promise<Response> {
  const refreshToken = params.get("refresh_token");
  if (!refreshToken) {
    return jsonError(400, "invalid_request", "refresh_token is required");
  }

  let payload: RefreshTokenPayload;
  try {
    payload = await verifyJwt<RefreshTokenPayload>(refreshToken, signingKey);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return jsonError(400, "invalid_grant", `refresh_token invalid: ${message}`);
  }

  if (payload.typ !== "refresh") {
    return jsonError(400, "invalid_grant", "token is not a refresh token");
  }

  const tokens = await issueTokenPair({ issuer, signingKey });
  return jsonResponse({
    ...tokens,
    token_type: "Bearer",
    scope: payload.scope,
  });
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

async function readTokenParams(
  request: Request
): Promise<URLSearchParams | Response> {
  const ct = request.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/x-www-form-urlencoded")) {
      const text = await request.text();
      return new URLSearchParams(text);
    }
    if (ct.includes("application/json")) {
      const obj = (await request.json()) as Record<string, unknown>;
      const out = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined && v !== null) out.set(k, String(v));
      }
      return out;
    }
    // Fall back to attempting form-urlencoded parse.
    const text = await request.text();
    return new URLSearchParams(text);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return jsonError(400, "invalid_request", `Failed to parse body: ${message}`);
  }
}

function jsonError(status: number, error: string, error_description: string): Response {
  return jsonResponse({ error, error_description }, { status });
}

/** S256: base64url(SHA-256(ascii(verifier))). */
async function s256Base64Url(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Re-export for legacy import paths.
export { issuerFromRequest };

// silence unused import warning when corsResponse isn't actually referenced.
void corsResponse;

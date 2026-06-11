// -----------------------------------------------------------------------------
// src/oauth/authorize.ts — OAuth 2.1 authorization endpoint.
//
// claude.ai opens this URL in the user's browser. v1 is auto-approve: there
// is no consent page. We validate the request, mint a one-time auth code,
// and 302 the browser back to redirect_uri with ?code=...&state=....
//
// Security note: in public-client mode (OAUTH_CLIENT_ID/SECRET unset) anyone
// who reaches this endpoint can obtain a token — partners must keep their
// Worker URL private. Phase 11.1 confidential mode closes this: client_id
// must match the pre-shared OAUTH_CLIENT_ID here, and /token additionally
// requires the client_secret, so the URL alone is no longer sufficient.
//
// Error handling per RFC 6749 §4.1.2.1:
//   - If client_id or redirect_uri is invalid (or doesn't match), respond
//     400 JSON. Redirecting an attacker-controlled URL with a code-leaking
//     error would help phishing.
//   - If everything else is wrong (missing code_challenge, bad response_type,
//     etc.), redirect to redirect_uri with error=... query params and the
//     client's `state`.
// -----------------------------------------------------------------------------

import { corsResponse, jsonResponse } from "../cors";
import { confidentialClientConfigured } from "./confidential";
import { randomToken } from "./jwt";
import { ALLOWED_REDIRECT_URIS } from "./register";
import type { Env } from "../types";

interface ClientRow {
  client_id: string;
  redirect_uris: string;   // JSON-encoded array of strings
}

const AUTH_CODE_TTL_SECONDS = 60;

export async function handleAuthorize(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "GET") {
    return corsResponse("Method Not Allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const params = url.searchParams;
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const responseType = params.get("response_type");
  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method");
  const scope = params.get("scope") ?? "cdn:full";
  const state = params.get("state") ?? "";

  // -- Pre-redirect validation (return JSON, never a redirect) -----------
  if (!clientId) {
    return jsonResponse(
      { error: "invalid_request", error_description: "client_id is required" },
      { status: 400 }
    );
  }
  if (!redirectUri) {
    return jsonResponse(
      { error: "invalid_request", error_description: "redirect_uri is required" },
      { status: 400 }
    );
  }

  if (confidentialClientConfigured(env)) {
    // Phase 11.1 — the only valid client is the pre-shared one. There is no
    // DCR row for it, so redirect_uri is checked against the same static
    // allowlist /register enforces in public mode.
    if (clientId !== env.OAUTH_CLIENT_ID) {
      return jsonResponse(
        { error: "invalid_client", error_description: "unknown client_id" },
        { status: 400 }
      );
    }
    if (!ALLOWED_REDIRECT_URIS.has(redirectUri)) {
      return jsonResponse(
        {
          error: "invalid_redirect_uri",
          error_description: "redirect_uri is not on the allowlist",
        },
        { status: 400 }
      );
    }
  } else {
    const client = await env.DB.prepare(
      "SELECT client_id, redirect_uris FROM oauth_clients WHERE client_id = ?"
    )
      .bind(clientId)
      .first<ClientRow>();

    if (!client) {
      return jsonResponse(
        { error: "invalid_client", error_description: "client_id not registered" },
        { status: 400 }
      );
    }

    let registered: string[];
    try {
      registered = JSON.parse(client.redirect_uris) as string[];
    } catch {
      return jsonResponse(
        { error: "server_error", error_description: "client record is corrupt" },
        { status: 500 }
      );
    }
    if (!registered.includes(redirectUri)) {
      return jsonResponse(
        {
          error: "invalid_redirect_uri",
          error_description: "redirect_uri does not match the one registered for this client",
        },
        { status: 400 }
      );
    }
  }

  // -- Post-redirect validation (errors redirect with query params) ------
  if (responseType !== "code") {
    return redirectError(redirectUri, "unsupported_response_type", "Only response_type=code is supported", state);
  }
  if (!codeChallenge) {
    return redirectError(redirectUri, "invalid_request", "code_challenge is required (PKCE)", state);
  }
  if (codeChallengeMethod !== "S256") {
    return redirectError(redirectUri, "invalid_request", "code_challenge_method must be S256", state);
  }

  // -- Mint and store the auth code --------------------------------------
  const code = randomToken(32);                       // 64 hex chars, 256 bits
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000).toISOString();

  try {
    await env.DB.prepare(
      "INSERT INTO oauth_auth_codes (code, client_id, redirect_uri, code_challenge, scope, expires_at, used) VALUES (?, ?, ?, ?, ?, ?, 0)"
    )
      .bind(code, clientId, redirectUri, codeChallenge, scope, expiresAt)
      .run();
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return redirectError(redirectUri, "server_error", `Failed to issue code: ${message}`, state);
  }

  const location = new URL(redirectUri);
  location.searchParams.set("code", code);
  if (state) location.searchParams.set("state", state);

  return corsResponse(null, {
    status: 302,
    headers: { Location: location.toString() },
  });
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function redirectError(
  redirectUri: string,
  error: string,
  description: string,
  state: string
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return corsResponse(null, {
    status: 302,
    headers: { Location: url.toString() },
  });
}

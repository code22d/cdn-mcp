// -----------------------------------------------------------------------------
// src/oauth/signing-key.ts — single source of truth for the OAUTH_SIGNING_KEY
// secret.
//
// Per Phase 11 design: the Worker fails CLOSED on OAuth routes if the secret
// isn't set, but the legacy /mcp/<token> path still works. So we don't validate
// at module load — only when an OAuth-route handler needs the key.
//
// Returns the key as a string, OR a Response (500 with a clear OAuth error)
// that the caller can return directly.
// -----------------------------------------------------------------------------

import { jsonResponse } from "../cors";
import type { Env } from "../types";

const MIN_KEY_BYTES = 32; // 256 bits — enough for HMAC-SHA256 keying

export function requireSigningKey(env: Env): string | Response {
  const key = env.OAUTH_SIGNING_KEY;
  if (!key || key.length < MIN_KEY_BYTES) {
    return jsonResponse(
      {
        error: "server_error",
        error_description:
          "OAUTH_SIGNING_KEY not set (or too short). Run: wrangler secret put OAUTH_SIGNING_KEY",
      },
      { status: 500 }
    );
  }
  return key;
}

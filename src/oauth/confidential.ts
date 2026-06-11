// -----------------------------------------------------------------------------
// src/oauth/confidential.ts — Phase 11.1 confidential-client helpers.
//
// When BOTH OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET are set as Worker secrets,
// the OAuth server switches from public-client mode (DCR + auto-approve, URL
// is the only secret) to confidential-client mode:
//   /register  → 401 registration_not_supported (registration is out-of-band:
//                the operator runs `wrangler secret put`)
//   /authorize → client_id query param must equal OAUTH_CLIENT_ID
//   /token     → client must authenticate with client_id + client_secret
//                (Basic header or POST body, RFC 6749 §2.3.1)
//
// If only ONE of the two secrets is set, we treat the pair as unset (public-
// client behavior everywhere) and log a warning once per isolate so the
// operator notices the half-configured state.
// -----------------------------------------------------------------------------

import type { Env } from "../types";

let warnedPartialConfig = false;

/** True when both confidential-client secrets are present and non-empty. */
export function confidentialClientConfigured(env: Env): boolean {
  const hasId = typeof env.OAUTH_CLIENT_ID === "string" && env.OAUTH_CLIENT_ID.length > 0;
  const hasSecret =
    typeof env.OAUTH_CLIENT_SECRET === "string" && env.OAUTH_CLIENT_SECRET.length > 0;
  if (hasId !== hasSecret && !warnedPartialConfig) {
    warnedPartialConfig = true;
    console.warn(
      "[cdn-mcp] Only one of OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET is set. " +
        "Confidential-client enforcement is DISABLED until both are set via " +
        "`wrangler secret put`."
    );
  }
  return hasId && hasSecret;
}

/**
 * Constant-time string equality. Cloudflare Workers expose the non-standard
 * crypto.subtle.timingSafeEqual; Node (where tests run) does not, so we fall
 * back to a manual XOR-and-or loop. Length mismatch returns false but still
 * burns a comparison over the expected value so timing doesn't reveal a
 * prefix match.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);

  const subtle = crypto.subtle as { timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean };
  if (ab.byteLength === bb.byteLength && typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(ab.buffer as ArrayBuffer, bb.buffer as ArrayBuffer);
  }

  const len = Math.max(ab.byteLength, bb.byteLength);
  let diff = ab.byteLength === bb.byteLength ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

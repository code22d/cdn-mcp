// -----------------------------------------------------------------------------
// src/oauth/jwt.ts — minimal HS256 JWT sign/verify via Web Crypto.
//
// We deliberately do NOT pull in a third-party JWT library. The Worker runtime
// ships Web Crypto (crypto.subtle); Node 18+ does too, so the same helpers work
// in the test suite under tsx without changes.
//
// Token shape:
//   <base64url header>.<base64url payload>.<base64url HMAC-SHA256(header.payload)>
// Header is fixed: { alg: "HS256", typ: "JWT" }.
//
// verifyJwt returns the payload on success and throws on any failure
// (bad signature, malformed, expired). Callers translate that into the
// appropriate OAuth error (invalid_grant for refresh, 401 for /mcp).
// -----------------------------------------------------------------------------

const HEADER_B64 = base64urlEncode(
  new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))
);

export interface AccessTokenPayload {
  iss: string;             // issuer (worker URL)
  sub: string;             // subject — "cdn-user" (single-tenant)
  aud: string;             // audience — issuer URL (this resource)
  scope: string;           // "cdn:full"
  iat: number;             // issued-at (epoch seconds)
  exp: number;             // expiry (epoch seconds)
  typ: "access";
}

export interface RefreshTokenPayload {
  iss: string;
  sub: string;
  aud: string;
  scope: string;
  iat: number;
  exp: number;
  typ: "refresh";
  // jti exists so future revocation lists could blacklist by id without
  // needing to invalidate the signing key. Not enforced in v1.
  jti: string;
}

export type JwtPayload = AccessTokenPayload | RefreshTokenPayload;

/**
 * Sign a payload as a compact JWT. The payload is JSON-stringified as-is —
 * callers are responsible for including iat/exp/etc.
 */
export async function signJwt(
  payload: JwtPayload,
  signingKey: string
): Promise<string> {
  const payloadB64 = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(payload))
  );
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const sig = await hmacSign(signingInput, signingKey);
  return `${signingInput}.${sig}`;
}

/**
 * Verify a JWT and return its parsed payload. Throws on any failure —
 * malformed, bad signature, expired. Callers MUST catch and convert to the
 * appropriate OAuth/HTTP error.
 *
 * Constant-time comparison of signatures matters here: a timing oracle on the
 * signature byte-by-byte would let an attacker forge tokens. crypto.subtle's
 * verify() is constant-time; we use it instead of comparing strings.
 */
export async function verifyJwt<T extends JwtPayload = JwtPayload>(
  token: string,
  signingKey: string
): Promise<T> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("jwt_malformed: expected 3 segments");
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Header is fixed in our system — anything else is rejected. Defends against
  // the classic "alg: none" downgrade.
  if (headerB64 !== HEADER_B64) {
    let parsedHeader: unknown;
    try {
      parsedHeader = JSON.parse(
        new TextDecoder().decode(base64urlDecode(headerB64))
      );
    } catch {
      throw new Error("jwt_bad_header: header not valid base64url JSON");
    }
    throw new Error(
      `jwt_bad_header: unexpected header ${JSON.stringify(parsedHeader)}`
    );
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  const ok = await hmacVerify(signingInput, sigB64, signingKey);
  if (!ok) {
    throw new Error("jwt_bad_signature");
  }

  let payload: T;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64urlDecode(payloadB64))
    ) as T;
  } catch {
    throw new Error("jwt_bad_payload: not valid base64url JSON");
  }

  // Expiry check — allow 5s of clock skew. iat/exp are epoch seconds.
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + 5 < now) {
    throw new Error("jwt_expired");
  }

  return payload;
}

// -----------------------------------------------------------------------------
// Internal Web Crypto helpers
// -----------------------------------------------------------------------------

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function hmacSign(input: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(input)
  );
  return base64urlEncode(new Uint8Array(sig));
}

async function hmacVerify(
  input: string,
  sigB64: string,
  secret: string
): Promise<boolean> {
  const key = await importKey(secret);
  let sig: Uint8Array;
  try {
    sig = base64urlDecode(sigB64);
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    "HMAC",
    key,
    sig as unknown as ArrayBuffer,
    new TextEncoder().encode(input)
  );
}

// -----------------------------------------------------------------------------
// base64url — RFC 4648 §5. Standard atob/btoa work on standard base64; we add
// the url-safe variant inline rather than pulling a dep.
// -----------------------------------------------------------------------------

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  // atob requires correctly-padded input.
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// -----------------------------------------------------------------------------
// Convenience: build + sign access + refresh token pairs
// -----------------------------------------------------------------------------

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;          // 1 hour
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export async function issueTokenPair(args: {
  issuer: string;
  signingKey: string;
}): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const now = Math.floor(Date.now() / 1000);
  const access: AccessTokenPayload = {
    iss: args.issuer,
    sub: "cdn-user",
    aud: args.issuer,
    scope: "cdn:full",
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    typ: "access",
  };
  const refresh: RefreshTokenPayload = {
    iss: args.issuer,
    sub: "cdn-user",
    aud: args.issuer,
    scope: "cdn:full",
    iat: now,
    exp: now + REFRESH_TOKEN_TTL_SECONDS,
    typ: "refresh",
    jti: randomToken(16),
  };
  const [access_token, refresh_token] = await Promise.all([
    signJwt(access, args.signingKey),
    signJwt(refresh, args.signingKey),
  ]);
  return {
    access_token,
    refresh_token,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
  };
}

/** Random hex string. Used for jti and auth codes. */
export function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += buf[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

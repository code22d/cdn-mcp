// -----------------------------------------------------------------------------
// test/phase11.ts — Phase 11 synthetic tests.
//
// Phase 11 adds OAuth 2.1 + DCR + Streamable HTTP. These tests exercise:
//   - JWT round-trip + tamper rejection (signature, expiry, alg-none defense)
//   - Both .well-known/* metadata documents
//   - /register: happy path, allowlist enforcement, missing-fields
//   - /authorize → /token full PKCE flow
//   - /token: replay rejection, expired code, bad code_verifier, refresh grant
//   - /mcp: 401 + WWW-Authenticate when Bearer missing/invalid
//   - /mcp: tools/list works with a valid Bearer
//   - Legacy /mcp/<token> still works (Cowork plugin compat)
//   - OAUTH_SIGNING_KEY missing fails OAuth routes but not legacy /mcp/<token>
//
// We don't import from test/_mock.ts because the OAuth path uses entirely
// different SQL (oauth_clients, oauth_auth_codes). A focused in-file mock is
// cheaper than expanding _mock.ts for code only Phase 11 exercises.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";

import worker from "../src/index";
import {
  signJwt,
  verifyJwt,
  issueTokenPair,
  type AccessTokenPayload,
  type RefreshTokenPayload,
} from "../src/oauth/jwt";
import type { Env } from "../src/types";

// -----------------------------------------------------------------------------
// In-memory D1 mock — minimal coverage of the OAuth SQL.
// -----------------------------------------------------------------------------

interface OauthClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string;
  client_metadata: string | null;
  registered_at: string;
}

interface OauthAuthCodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  expires_at: string;
  used: number;
}

class OauthStore {
  clients: OauthClientRow[] = [];
  codes: OauthAuthCodeRow[] = [];
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

class OauthStatement {
  constructor(
    private store: OauthStore,
    private sql: string,
    private boundArgs: unknown[] = []
  ) {}

  bind(...args: unknown[]): OauthStatement {
    return new OauthStatement(this.store, this.sql, args);
  }

  async first<T = unknown>(): Promise<T | null> {
    const sql = normalize(this.sql);

    if (sql === "SELECT client_id, redirect_uris FROM oauth_clients WHERE client_id = ?") {
      const [id] = this.boundArgs as [string];
      const c = this.store.clients.find((x) => x.client_id === id);
      return c
        ? ({ client_id: c.client_id, redirect_uris: c.redirect_uris } as unknown as T)
        : null;
    }

    if (
      sql ===
      "SELECT code, client_id, redirect_uri, code_challenge, scope, expires_at, used FROM oauth_auth_codes WHERE code = ?"
    ) {
      const [code] = this.boundArgs as [string];
      const r = this.store.codes.find((x) => x.code === code);
      return r ? ({ ...r } as unknown as T) : null;
    }

    throw new Error(`OauthMockD1.first: unhandled SQL: ${sql}`);
  }

  async run(): Promise<{ success: true }> {
    const sql = normalize(this.sql);

    if (
      sql ===
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, client_metadata, registered_at) VALUES (?, ?, ?, ?, ?)"
    ) {
      const [client_id, client_name, redirect_uris, client_metadata, registered_at] =
        this.boundArgs as [string, string | null, string, string | null, string];
      this.store.clients.push({
        client_id,
        client_name,
        redirect_uris,
        client_metadata,
        registered_at,
      });
      return { success: true };
    }

    if (
      sql ===
      "INSERT INTO oauth_auth_codes (code, client_id, redirect_uri, code_challenge, scope, expires_at, used) VALUES (?, ?, ?, ?, ?, ?, 0)"
    ) {
      const [code, client_id, redirect_uri, code_challenge, scope, expires_at] =
        this.boundArgs as [string, string, string, string, string, string];
      this.store.codes.push({
        code,
        client_id,
        redirect_uri,
        code_challenge,
        scope,
        expires_at,
        used: 0,
      });
      return { success: true };
    }

    if (sql === "UPDATE oauth_auth_codes SET used = 1 WHERE code = ?") {
      const [code] = this.boundArgs as [string];
      const r = this.store.codes.find((x) => x.code === code);
      if (r) r.used = 1;
      return { success: true };
    }

    throw new Error(`OauthMockD1.run: unhandled SQL: ${sql}`);
  }

  async all<T = unknown>(): Promise<{ results: T[]; success: true }> {
    throw new Error(`OauthMockD1.all: unhandled SQL: ${normalize(this.sql)}`);
  }
}

class OauthMockD1 {
  constructor(public store: OauthStore) {}
  prepare(sql: string): OauthStatement {
    return new OauthStatement(this.store, sql);
  }
}

function makeEnv(opts: { signingKey?: string; mcpToken?: string } = {}): {
  env: Env;
  store: OauthStore;
} {
  const store = new OauthStore();
  const env: Env = {
    ASSETS: {} as unknown as R2Bucket,
    DB: new OauthMockD1(store) as unknown as D1Database,
    PUBLIC_URL_PREFIX: "https://cdn.22d.app",
    MCP_AUTH_TOKEN: opts.mcpToken ?? "legacy-test-token",
    CLOUDFLARE_ACCOUNT_ID: "test-account-id",
    R2_ACCESS_KEY_ID: "TESTACCESSKEYID0000",
    R2_SECRET_ACCESS_KEY: "TestSecretAccessKey0000000000000000000000",
    OAUTH_SIGNING_KEY:
      opts.signingKey ?? "test-oauth-signing-key-32-bytes-of-entropy-padded",
  };
  return { env, store };
}

// Direct worker invocation. Worker's fetch handler signature is (request, env)
// — the optional third `ctx` parameter is omitted from our implementation, so
// TS will complain about a 3-arg call. Call with 2.
async function fetchWorker(request: Request, env: Env): Promise<Response> {
  return worker.fetch!(request, env);
}

// -----------------------------------------------------------------------------
// PKCE helpers — same algorithm as src/oauth/token.ts s256Base64Url.
// -----------------------------------------------------------------------------

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// -----------------------------------------------------------------------------
// Test runner
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;

function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        console.log(`  ✓ ${label}`);
        pass++;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.log(`  ✗ ${label}\n    ${message}`);
        fail++;
      }
    );
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

const ALLOWED_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function main() {
  console.log("cdn-mcp Phase 11 tests");
  console.log("======================");

  // ---------------- JWT ----------------------------------------------------

  await check("JWT round-trip (sign → verify) returns same payload", async () => {
    const key = "phase11-test-key-with-plenty-of-entropy-for-hmac";
    const payload: AccessTokenPayload = {
      iss: "https://example.com",
      sub: "cdn-user",
      aud: "https://example.com",
      scope: "cdn:full",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      typ: "access",
    };
    const tok = await signJwt(payload, key);
    const decoded = await verifyJwt<AccessTokenPayload>(tok, key);
    assert.deepEqual(decoded, payload);
  });

  await check("JWT verify rejects bad signature", async () => {
    const key = "phase11-test-key-with-plenty-of-entropy-for-hmac";
    const payload: AccessTokenPayload = {
      iss: "x",
      sub: "x",
      aud: "x",
      scope: "cdn:full",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      typ: "access",
    };
    const tok = await signJwt(payload, key);
    // Flip a character in the signature segment.
    const parts = tok.split(".");
    const sig = parts[2]!;
    const tampered = parts[0] + "." + parts[1] + "." + (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    await assert.rejects(
      () => verifyJwt(tampered, key),
      /jwt_bad_signature/
    );
  });

  await check("JWT verify rejects expired token", async () => {
    const key = "phase11-test-key-with-plenty-of-entropy-for-hmac";
    const payload: AccessTokenPayload = {
      iss: "x",
      sub: "x",
      aud: "x",
      scope: "cdn:full",
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600, // expired 1h ago
      typ: "access",
    };
    const tok = await signJwt(payload, key);
    await assert.rejects(
      () => verifyJwt(tok, key),
      /jwt_expired/
    );
  });

  await check("JWT verify rejects an alg:none header (downgrade defense)", async () => {
    const key = "phase11-test-key-with-plenty-of-entropy-for-hmac";
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "x", sub: "x", aud: "x", scope: "cdn:full",
        iat: 0, exp: 9999999999, typ: "access",
      })
    ).toString("base64url");
    const tok = `${noneHeader}.${payload}.`;
    await assert.rejects(
      () => verifyJwt(tok, key),
      /jwt_bad_header/
    );
  });

  await check("issueTokenPair returns valid access + refresh JWTs", async () => {
    const key = "phase11-test-key-with-plenty-of-entropy-for-hmac";
    const { access_token, refresh_token, expires_in } = await issueTokenPair({
      issuer: "https://cdn-mcp.example",
      signingKey: key,
    });
    const a = await verifyJwt<AccessTokenPayload>(access_token, key);
    const r = await verifyJwt<RefreshTokenPayload>(refresh_token, key);
    assert.equal(a.typ, "access");
    assert.equal(r.typ, "refresh");
    assert.equal(a.iss, "https://cdn-mcp.example");
    assert.equal(a.scope, "cdn:full");
    assert.equal(expires_in, 3600);
  });

  // ---------------- .well-known --------------------------------------------

  await check("GET /.well-known/oauth-protected-resource returns expected shape", async () => {
    const { env } = makeEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/.well-known/oauth-protected-resource"),
      env
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    };
    assert.equal(body.resource, "https://cdn-mcp.example");
    assert.deepEqual(body.authorization_servers, ["https://cdn-mcp.example"]);
    assert.deepEqual(body.scopes_supported, ["cdn:full"]);
    assert.deepEqual(body.bearer_methods_supported, ["header"]);
  });

  await check("GET /.well-known/oauth-authorization-server lists endpoints + S256", async () => {
    const { env } = makeEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/.well-known/oauth-authorization-server"),
      env
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
      response_types_supported: string[];
      grant_types_supported: string[];
      token_endpoint_auth_methods_supported: string[];
    };
    assert.equal(body.issuer, "https://cdn-mcp.example");
    assert.equal(body.authorization_endpoint, "https://cdn-mcp.example/authorize");
    assert.equal(body.token_endpoint, "https://cdn-mcp.example/token");
    assert.equal(body.registration_endpoint, "https://cdn-mcp.example/register");
    assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(body.response_types_supported, ["code"]);
    assert.deepEqual(body.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.deepEqual(body.token_endpoint_auth_methods_supported, ["none"]);
  });

  // ---------------- /register ----------------------------------------------

  await check("POST /register happy path returns client_id, persists row", async () => {
    const { env, store } = makeEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "claude.ai",
          redirect_uris: [ALLOWED_REDIRECT],
        }),
      }),
      env
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      client_id: string;
      redirect_uris: string[];
      token_endpoint_auth_method: string;
    };
    assert.ok(body.client_id.length > 10, "client_id must look like a UUID");
    assert.deepEqual(body.redirect_uris, [ALLOWED_REDIRECT]);
    assert.equal(body.token_endpoint_auth_method, "none");
    assert.equal(store.clients.length, 1);
    assert.equal(store.clients[0]!.client_id, body.client_id);
  });

  await check("POST /register rejects non-allowlisted redirect_uri", async () => {
    const { env, store } = makeEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "evil",
          redirect_uris: ["https://attacker.example/callback"],
        }),
      }),
      env
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_redirect_uri");
    assert.equal(store.clients.length, 0);
  });

  await check("POST /register rejects missing redirect_uris", async () => {
    const { env } = makeEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "no-redirect" }),
      }),
      env
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_redirect_uri");
  });

  // ---------------- /authorize → /token full PKCE flow ---------------------

  await check("end-to-end: /register → /authorize → /token returns access+refresh", async () => {
    const { env } = makeEnv();

    // 1. register
    const regRes = await fetchWorker(
      new Request("https://cdn-mcp.example/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "e2e",
          redirect_uris: [ALLOWED_REDIRECT],
        }),
      }),
      env
    );
    assert.equal(regRes.status, 201);
    const { client_id } = (await regRes.json()) as { client_id: string };

    // 2. PKCE pair
    const verifier = "e2e-test-verifier-with-enough-entropy-1234567890";
    const challenge = await s256(verifier);

    // 3. authorize
    const authUrl = new URL("https://cdn-mcp.example/authorize");
    authUrl.searchParams.set("client_id", client_id);
    authUrl.searchParams.set("redirect_uri", ALLOWED_REDIRECT);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", "xyz");
    authUrl.searchParams.set("scope", "cdn:full");

    const authRes = await fetchWorker(
      new Request(authUrl.toString(), { method: "GET" }),
      env
    );
    assert.equal(authRes.status, 302);
    const location = authRes.headers.get("Location");
    assert.ok(location, "missing Location header on /authorize redirect");
    const locUrl = new URL(location!);
    assert.equal(`${locUrl.origin}${locUrl.pathname}`, ALLOWED_REDIRECT);
    assert.equal(locUrl.searchParams.get("state"), "xyz");
    const code = locUrl.searchParams.get("code");
    assert.ok(code && code.length > 16, "missing/short auth code");

    // 4. token (form-urlencoded body)
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: ALLOWED_REDIRECT,
      client_id,
      code_verifier: verifier,
    });
    const tokenRes = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
      }),
      env
    );
    assert.equal(tokenRes.status, 200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.expires_in, 3600);
    assert.equal(tokens.scope, "cdn:full");
    assert.ok(tokens.access_token.split(".").length === 3);
    assert.ok(tokens.refresh_token.split(".").length === 3);
  });

  await check("/authorize rejects unknown client_id with 400 JSON", async () => {
    const { env } = makeEnv();
    const u = new URL("https://cdn-mcp.example/authorize");
    u.searchParams.set("client_id", "nope-does-not-exist");
    u.searchParams.set("redirect_uri", ALLOWED_REDIRECT);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("code_challenge", "x");
    u.searchParams.set("code_challenge_method", "S256");
    const res = await fetchWorker(new Request(u.toString()), env);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_client");
  });

  await check("/authorize redirects with error on missing code_challenge", async () => {
    const { env } = makeEnv();
    // First register a client so we get past the client check
    const regRes = await fetchWorker(
      new Request("https://cdn-mcp.example/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "x",
          redirect_uris: [ALLOWED_REDIRECT],
        }),
      }),
      env
    );
    const { client_id } = (await regRes.json()) as { client_id: string };

    const u = new URL("https://cdn-mcp.example/authorize");
    u.searchParams.set("client_id", client_id);
    u.searchParams.set("redirect_uri", ALLOWED_REDIRECT);
    u.searchParams.set("response_type", "code");
    // omit code_challenge
    u.searchParams.set("state", "abc");
    const res = await fetchWorker(new Request(u.toString()), env);
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("Location")!);
    assert.equal(loc.searchParams.get("error"), "invalid_request");
    assert.equal(loc.searchParams.get("state"), "abc");
  });

  // ---------------- /token failure paths -----------------------------------

  await check("/token rejects used auth code (replay)", async () => {
    const { env } = makeEnv();
    const reg = (await (
      await fetchWorker(
        new Request("https://cdn-mcp.example/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "replay",
            redirect_uris: [ALLOWED_REDIRECT],
          }),
        }),
        env
      )
    ).json()) as { client_id: string };

    const verifier = "replay-test-verifier-with-enough-entropy-12345678";
    const challenge = await s256(verifier);
    const u = new URL("https://cdn-mcp.example/authorize");
    u.searchParams.set("client_id", reg.client_id);
    u.searchParams.set("redirect_uri", ALLOWED_REDIRECT);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    const authRes = await fetchWorker(new Request(u.toString()), env);
    const code = new URL(authRes.headers.get("Location")!).searchParams.get("code")!;

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ALLOWED_REDIRECT,
      client_id: reg.client_id,
      code_verifier: verifier,
    });

    // First exchange succeeds
    const r1 = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
      }),
      env
    );
    assert.equal(r1.status, 200);
    // Second exchange MUST fail (replay).
    const r2 = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
      }),
      env
    );
    assert.equal(r2.status, 400);
    const body = (await r2.json()) as { error: string };
    assert.equal(body.error, "invalid_grant");
  });

  await check("/token rejects mismatched code_verifier (PKCE failure)", async () => {
    const { env } = makeEnv();
    const reg = (await (
      await fetchWorker(
        new Request("https://cdn-mcp.example/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "pkce-fail",
            redirect_uris: [ALLOWED_REDIRECT],
          }),
        }),
        env
      )
    ).json()) as { client_id: string };

    const challenge = await s256("real-verifier-12345678901234567890123456");
    const u = new URL("https://cdn-mcp.example/authorize");
    u.searchParams.set("client_id", reg.client_id);
    u.searchParams.set("redirect_uri", ALLOWED_REDIRECT);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    const authRes = await fetchWorker(new Request(u.toString()), env);
    const code = new URL(authRes.headers.get("Location")!).searchParams.get("code")!;

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ALLOWED_REDIRECT,
      client_id: reg.client_id,
      code_verifier: "wrong-verifier-doesnt-match-the-challenge-123",
    });
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
      }),
      env
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_grant");
  });

  await check("/token refresh_token grant returns a new pair", async () => {
    const { env } = makeEnv();
    const { refresh_token: rt } = await issueTokenPair({
      issuer: "https://cdn-mcp.example",
      signingKey: env.OAUTH_SIGNING_KEY,
    });
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt }).toString(),
      }),
      env
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { access_token: string; refresh_token: string };
    assert.ok(body.access_token.split(".").length === 3);
    assert.ok(body.refresh_token.split(".").length === 3);
    assert.notEqual(body.refresh_token, rt, "refresh token must rotate");
  });

  await check("/token refresh_token rejects a tampered token", async () => {
    const { env } = makeEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "not.a.jwt",
        }).toString(),
      }),
      env
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_grant");
  });

  // ---------------- /mcp Bearer enforcement --------------------------------

  await check("POST /mcp without Authorization returns 401 + WWW-Authenticate", async () => {
    const { env } = makeEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      env
    );
    assert.equal(res.status, 401);
    const www = res.headers.get("WWW-Authenticate") ?? "";
    assert.ok(www.startsWith("Bearer "), `WWW-Authenticate not Bearer: ${www}`);
    assert.ok(
      www.includes("/.well-known/oauth-protected-resource"),
      `WWW-Authenticate missing resource_metadata: ${www}`
    );
  });

  await check("POST /mcp with valid Bearer dispatches and tools/list returns 13", async () => {
    const { env } = makeEnv();
    const { access_token } = await issueTokenPair({
      issuer: "https://cdn-mcp.example",
      signingKey: env.OAUTH_SIGNING_KEY,
    });
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      env
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    assert.equal(body.result.tools.length, 13);
  });

  await check("POST /mcp with malformed Bearer returns 401", async () => {
    const { env } = makeEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer not.a.valid.jwt",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      env
    );
    assert.equal(res.status, 401);
  });

  await check("GET /mcp with valid Bearer returns text/event-stream", async () => {
    const { env } = makeEnv();
    const { access_token } = await issueTokenPair({
      issuer: "https://cdn-mcp.example",
      signingKey: env.OAUTH_SIGNING_KEY,
    });
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/mcp", {
        method: "GET",
        headers: { authorization: `Bearer ${access_token}` },
      }),
      env
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/event-stream");
    // Read one chunk so we know the stream actually flushed the initial keep-alive.
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.ok(text.startsWith(":"), `expected SSE comment, got: ${text}`);
    await reader.cancel();
  });

  // ---------------- Legacy compat ------------------------------------------

  await check("legacy /mcp/<token> still dispatches tools/list to 13 tools", async () => {
    const { env } = makeEnv({ mcpToken: "phase11-legacy-token" });
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/mcp/phase11-legacy-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      env
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { tools: unknown[] } };
    assert.equal(body.result.tools.length, 13);
  });

  // ---------------- OAUTH_SIGNING_KEY missing ------------------------------

  await check("missing OAUTH_SIGNING_KEY → /token returns 500 server_error", async () => {
    const { env } = makeEnv({ signingKey: "" });
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "x.y.z" }).toString(),
      }),
      env
    );
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string; error_description: string };
    assert.equal(body.error, "server_error");
    assert.ok(body.error_description.includes("OAUTH_SIGNING_KEY"));
  });

  await check("missing OAUTH_SIGNING_KEY does NOT break legacy /mcp/<token>", async () => {
    const { env } = makeEnv({ signingKey: "", mcpToken: "phase11-legacy-token" });
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/mcp/phase11-legacy-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      env
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { tools: unknown[] } };
    assert.equal(body.result.tools.length, 13);
  });

  // ---------------- Discovery 401 surface ---------------------------------

  await check("CORS Allow-Headers exposes Authorization", async () => {
    const { env } = makeEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/mcp", { method: "OPTIONS" }),
      env
    );
    assert.equal(res.status, 200);
    const allowed = res.headers.get("Access-Control-Allow-Headers") ?? "";
    assert.ok(/Authorization/i.test(allowed), `Allow-Headers missing Authorization: ${allowed}`);
  });

  await check("CORS Expose-Headers exposes WWW-Authenticate", async () => {
    const { env } = makeEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env
    );
    assert.equal(res.status, 401);
    const exposed = res.headers.get("Access-Control-Expose-Headers") ?? "";
    assert.ok(/WWW-Authenticate/i.test(exposed), `Expose-Headers missing WWW-Authenticate: ${exposed}`);
  });

  // ---------------- Done --------------------------------------------------
  console.log("======================");
  console.log(`  ${pass} pass / ${fail} fail`);
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("Unhandled error in phase 11 tests:", err);
  process.exit(1);
});

// -----------------------------------------------------------------------------
// test/phase11_1.ts — Phase 11.1 synthetic tests: confidential OAuth client.
//
// When OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET are both set:
//   - /register rejects DCR with 401 registration_not_supported
//   - /authorize 400s on wrong client_id, issues a code for the right one
//     (no DCR row needed — redirect_uri checked against the static allowlist)
//   - /token requires client credentials: Basic header or POST body,
//     header takes precedence; wrong/missing → 401 invalid_client
//   - metadata advertises client_secret_basic + client_secret_post
//   - legacy /mcp/<token> is untouched
// When only ONE of the two is set: public-client behavior everywhere
// (backward compat). Phase 11 tests (run separately) cover the both-unset path.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";

import worker from "../src/index";
import { timingSafeEqualStr } from "../src/oauth/confidential";
import type { Env } from "../src/types";

// -----------------------------------------------------------------------------
// In-memory D1 mock — same minimal OAuth SQL coverage as test/phase11.ts.
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

const CLIENT_ID = "cdn-mcp-claude";
const CLIENT_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeEnv(opts: { clientId?: string; clientSecret?: string } = {}): {
  env: Env;
  store: OauthStore;
} {
  const store = new OauthStore();
  const env: Env = {
    ASSETS: {} as unknown as R2Bucket,
    DB: new OauthMockD1(store) as unknown as D1Database,
    PUBLIC_URL_PREFIX: "https://cdn.22d.app",
    MCP_AUTH_TOKEN: "legacy-test-token",
    CLOUDFLARE_ACCOUNT_ID: "test-account-id",
    R2_ACCESS_KEY_ID: "TESTACCESSKEYID0000",
    R2_SECRET_ACCESS_KEY: "TestSecretAccessKey0000000000000000000000",
    OAUTH_SIGNING_KEY: "test-oauth-signing-key-32-bytes-of-entropy-padded",
    OAUTH_CLIENT_ID: opts.clientId,
    OAUTH_CLIENT_SECRET: opts.clientSecret,
  };
  return { env, store };
}

/** Default: full confidential config. */
function makeConfidentialEnv() {
  return makeEnv({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
}

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

const ALLOWED_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** Run /authorize with the confidential client_id, return the auth code. */
async function obtainAuthCode(env: Env, verifier: string): Promise<string> {
  const challenge = await s256(verifier);
  const u = new URL("https://cdn-mcp.example/authorize");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", ALLOWED_REDIRECT);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", "s");
  const res = await fetchWorker(new Request(u.toString()), env);
  assert.equal(res.status, 302, "expected /authorize to redirect with a code");
  const code = new URL(res.headers.get("Location")!).searchParams.get("code");
  assert.ok(code, "missing code on /authorize redirect");
  return code!;
}

function basicAuth(id: string, secret: string): string {
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
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

async function main() {
  console.log("cdn-mcp Phase 11.1 tests");
  console.log("========================");

  // ---------------- timingSafeEqualStr -------------------------------------

  await check("timingSafeEqualStr: equal / unequal / length-mismatch / empty", () => {
    assert.equal(timingSafeEqualStr("abc", "abc"), true);
    assert.equal(timingSafeEqualStr("abc", "abd"), false);
    assert.equal(timingSafeEqualStr("abc", "abcd"), false);
    assert.equal(timingSafeEqualStr("abc", ""), false);
    assert.equal(timingSafeEqualStr("", ""), true);
  });

  // ---------------- /register ----------------------------------------------

  await check("/register returns 401 registration_not_supported when secrets set", async () => {
    const { env, store } = makeConfidentialEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "test",
          redirect_uris: [ALLOWED_REDIRECT],
        }),
      }),
      env
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "registration_not_supported");
    assert.equal(store.clients.length, 0);
  });

  await check("/register still works when only OAUTH_CLIENT_ID is set (partial config)", async () => {
    const { env, store } = makeEnv({ clientId: CLIENT_ID });
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "partial",
          redirect_uris: [ALLOWED_REDIRECT],
        }),
      }),
      env
    );
    assert.equal(res.status, 201);
    assert.equal(store.clients.length, 1);
  });

  // ---------------- /authorize ---------------------------------------------

  await check("/authorize 400 invalid_client on wrong client_id", async () => {
    const { env } = makeConfidentialEnv();
    const u = new URL("https://cdn-mcp.example/authorize");
    u.searchParams.set("client_id", "wrong");
    u.searchParams.set("redirect_uri", ALLOWED_REDIRECT);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("code_challenge", await s256("v"));
    u.searchParams.set("code_challenge_method", "S256");
    const res = await fetchWorker(new Request(u.toString()), env);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_client");
  });

  await check("/authorize 400 on missing client_id", async () => {
    const { env } = makeConfidentialEnv();
    const u = new URL("https://cdn-mcp.example/authorize");
    u.searchParams.set("redirect_uri", ALLOWED_REDIRECT);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("code_challenge", "test");
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("state", "x");
    const res = await fetchWorker(new Request(u.toString()), env);
    assert.equal(res.status, 400);
  });

  await check("/authorize 400 on non-allowlisted redirect_uri (confidential mode)", async () => {
    const { env } = makeConfidentialEnv();
    const u = new URL("https://cdn-mcp.example/authorize");
    u.searchParams.set("client_id", CLIENT_ID);
    u.searchParams.set("redirect_uri", "https://attacker.example/callback");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("code_challenge", await s256("v"));
    u.searchParams.set("code_challenge_method", "S256");
    const res = await fetchWorker(new Request(u.toString()), env);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_redirect_uri");
  });

  await check("/authorize issues a code for the pre-shared client_id (no DCR row)", async () => {
    const { env, store } = makeConfidentialEnv();
    const code = await obtainAuthCode(env, "authorize-happy-verifier-1234567890123456");
    assert.ok(code.length > 16);
    assert.equal(store.codes.length, 1);
    assert.equal(store.codes[0]!.client_id, CLIENT_ID);
  });

  // ---------------- /token -------------------------------------------------

  await check("/token 401 invalid_client on missing credentials", async () => {
    const { env } = makeConfidentialEnv();
    const verifier = "token-missing-creds-verifier-1234567890123456";
    const code = await obtainAuthCode(env, verifier);
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: ALLOWED_REDIRECT,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        }).toString(),
      }),
      env
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_client");
    assert.ok((res.headers.get("WWW-Authenticate") ?? "").startsWith("Basic"));
  });

  await check("/token 401 invalid_client on wrong client_secret (Basic)", async () => {
    const { env } = makeConfidentialEnv();
    const verifier = "token-wrong-secret-verifier-1234567890123456";
    const code = await obtainAuthCode(env, verifier);
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: basicAuth(CLIENT_ID, "wrong-secret"),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: ALLOWED_REDIRECT,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        }).toString(),
      }),
      env
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_client");
  });

  await check("/token 200 with correct Basic auth (client_id omitted from body)", async () => {
    const { env } = makeConfidentialEnv();
    const verifier = "token-basic-happy-verifier-1234567890123456";
    const code = await obtainAuthCode(env, verifier);
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: basicAuth(CLIENT_ID, CLIENT_SECRET),
        },
        // client_id deliberately omitted — the Basic header must supply it.
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: ALLOWED_REDIRECT,
          code_verifier: verifier,
        }).toString(),
      }),
      env
    );
    assert.equal(res.status, 200);
    const tokens = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
    };
    assert.equal(tokens.token_type, "Bearer");
    assert.ok(tokens.access_token.split(".").length === 3);
    assert.ok(tokens.refresh_token.split(".").length === 3);
  });

  await check("/token 200 with correct POST-body credentials", async () => {
    const { env } = makeConfidentialEnv();
    const verifier = "token-body-happy-verifier-1234567890123456";
    const code = await obtainAuthCode(env, verifier);
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: ALLOWED_REDIRECT,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code_verifier: verifier,
        }).toString(),
      }),
      env
    );
    assert.equal(res.status, 200);
    const tokens = (await res.json()) as { access_token: string };
    assert.ok(tokens.access_token.split(".").length === 3);
  });

  await check("/token Basic header takes precedence over body credentials", async () => {
    const { env } = makeConfidentialEnv();
    const verifier = "token-precedence-verifier-1234567890123456";
    const code = await obtainAuthCode(env, verifier);
    // Correct Basic header + wrong body secret → header wins → 200.
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: basicAuth(CLIENT_ID, CLIENT_SECRET),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: ALLOWED_REDIRECT,
          client_id: CLIENT_ID,
          client_secret: "wrong-body-secret",
          code_verifier: verifier,
        }).toString(),
      }),
      env
    );
    assert.equal(res.status, 200);
  });

  await check("/token refresh_token grant also requires client auth", async () => {
    const { env } = makeConfidentialEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "x.y.z",
        }).toString(),
      }),
      env
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_client");
  });

  await check("/token skips client auth when only OAUTH_CLIENT_SECRET is set (partial config)", async () => {
    const { env } = makeEnv({ clientSecret: CLIENT_SECRET });
    // No credentials anywhere — with partial config this must NOT 401; the
    // bogus refresh token then fails as invalid_grant (public-client path).
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "x.y.z",
        }).toString(),
      }),
      env
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_grant");
  });

  // ---------------- metadata ------------------------------------------------

  await check("AS metadata advertises client_secret_basic/post in confidential mode", async () => {
    const { env } = makeConfidentialEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/.well-known/oauth-authorization-server"),
      env
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      token_endpoint_auth_methods_supported: string[];
      registration_endpoint: string;
    };
    assert.deepEqual(body.token_endpoint_auth_methods_supported, [
      "client_secret_basic",
      "client_secret_post",
    ]);
    assert.equal(body.registration_endpoint, "https://cdn-mcp.example/register");
  });

  await check("AS metadata still advertises none when secrets unset", async () => {
    const { env } = makeEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/.well-known/oauth-authorization-server"),
      env
    );
    const body = (await res.json()) as { token_endpoint_auth_methods_supported: string[] };
    assert.deepEqual(body.token_endpoint_auth_methods_supported, ["none"]);
  });

  // ---------------- legacy compat -------------------------------------------

  await check("legacy /mcp/<token> still dispatches 13 tools with secrets set", async () => {
    const { env } = makeConfidentialEnv();
    const res = await fetchWorker(
      new Request("https://cdn-mcp.example/mcp/legacy-test-token", {
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

  // ---------------- Done ----------------------------------------------------
  console.log("========================");
  console.log(`  ${pass} pass / ${fail} fail`);
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("Unhandled error in phase 11.1 tests:", err);
  process.exit(1);
});

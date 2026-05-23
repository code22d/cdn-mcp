// -----------------------------------------------------------------------------
// Shared types for the cdn-mcp Worker.
// -----------------------------------------------------------------------------

export interface Env {
  // Bindings
  ASSETS: R2Bucket;
  DB: D1Database;

  // Vars (declared in wrangler.toml [vars])
  PUBLIC_URL_PREFIX: string;
  /**
   * Cloudflare account ID — embedded in the R2 S3 endpoint hostname for
   * SigV4 presigned URLs (`<account>.r2.cloudflarestorage.com`). Not a
   * secret: it leaks via every presigned URL anyway. Stored as a [vars]
   * entry rather than a secret so it's checked into wrangler.toml and
   * obvious in code review.
   */
  CLOUDFLARE_ACCOUNT_ID: string;

  // Secrets (set via `wrangler secret put`)
  MCP_AUTH_TOKEN: string;
  /**
   * R2 S3-compatible API access key ID — used to sign presigned PUT URLs
   * for cdn_signed_upload_url. Created via the R2 dashboard's "Manage R2
   * API Tokens" with Object Read & Write on the cdn-assets bucket. SEPARATE
   * from MCP_AUTH_TOKEN and any Cloudflare API token.
   */
  R2_ACCESS_KEY_ID: string;
  /**
   * R2 S3-compatible API secret access key — companion to
   * R2_ACCESS_KEY_ID. Shown ONCE in the dashboard at token creation time.
   */
  R2_SECRET_ACCESS_KEY: string;
  /**
   * Phase 11 OAuth signing key (HMAC-SHA256). Must be ≥ 32 bytes of entropy.
   * Generate with:  openssl rand -hex 32  (or `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`)
   * Set with:       wrangler secret put OAUTH_SIGNING_KEY
   * The legacy /mcp/<token> path keeps working even if this is unset; only
   * the new OAuth routes (/register, /authorize, /token, /mcp) fail closed.
   */
  OAUTH_SIGNING_KEY: string;
}

/** JSON-RPC 2.0 request/response envelopes per the MCP spec. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Context passed to every tool handler. */
export interface ToolContext {
  env: Env;
  request: Request;
}

/** A registered MCP tool. */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema (draft-07ish) for the tool's input arguments. */
  inputSchema: Record<string, unknown>;
  /** Async handler — returns the MCP `tools/call` result envelope. */
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Shape of `result` returned for `tools/call`. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

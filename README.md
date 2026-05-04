# cdn-mcp

A personal CDN backed by Cloudflare R2 (bytes), Cloudflare D1 (metadata), and a Cloudflare Worker that exposes everything as an MCP server. Upload images, videos, HTML files, or any other assets, organized into projects, and manage them from inside Claude (or any MCP client) via natural-language tool calls. Public URLs are stable — they don't change when you replace an asset.

Built phase-by-phase using a head-session/builder-session orchestration pattern. See the Notion docs below for the full design + decision history.

## Status

**Currently shipping `0.1.0-phase4.1`. 10 of 12 tools have real handlers; 2 remain stubs (cosmetic — `cdn_rename_file`, `cdn_set_cache_headers`).**

| Phase | Status | What shipped |
|---|---|---|
| 0 | ✅ | Scaffold + parity stubs for all 12 tools |
| 1 | ✅ | `cdn_upload_file`, `cdn_list_files`, `cdn_list_projects`, `cdn_create_project` |
| 2 | ✅ | `cdn_replace_file`, `cdn_delete_file` (+ `performUpload` refactor) |
| 3 | ✅ | `cdn_get_file`, `cdn_get_stats` |
| 4 | ✅ | `cdn_signed_upload_url`, `cdn_finalize_upload` (large-file uploads via SigV4) |
| 4.1 | ✅ | Cache-Control bake-in for fresh-on-replace + aws4fetch unsignable-headers fix |
| 5 | 🅿️ Parked | Admin UI / D1 explorer (optional) |

## Tool surface

The tool surface is **frozen**. New tool ideas → propose → register as stub → then implement.

| Tool | Purpose | Status |
|------|---------|---------|
| `cdn_upload_file` | Upload base64 bytes into a project. Auto-creates the project. | ✅ |
| `cdn_list_files` | List files in a project (or globally). Cursor-paginated. | ✅ |
| `cdn_list_projects` | List all projects with file count + total size. | ✅ |
| `cdn_create_project` | Pre-create an empty project. | ✅ |
| `cdn_replace_file` | Overwrite an existing file in place. Same URL, bumps version. | ✅ |
| `cdn_delete_file` | Remove a file (R2 + D1 row). | ✅ |
| `cdn_get_file` | Get metadata for one file by `(project, name)`. | ✅ |
| `cdn_get_stats` | Total storage / file count, optionally per-project. | ✅ |
| `cdn_signed_upload_url` | Presigned R2 URL for browser-direct PUT (>100MB files). | ✅ |
| `cdn_finalize_upload` | Insert metadata after a presigned-URL PUT succeeds. | ✅ |
| `cdn_rename_file` | Rename a file. Changes the public URL. | 🟡 stub |
| `cdn_set_cache_headers` | Per-file Cache-Control overrides. | 🟡 stub |

## Where to look for canonical docs

This README is the operational quick-start. Decisions, architecture rationale, head-session pre-flight rules, and per-phase test reports live in Notion:

- **Build Plan** — stack, architecture, tool surface, head-session pre-flight checklist, deferred trade-offs, task tracker: https://app.notion.com/p/353de14e04cc8115b0e1eacac6c7b432
- **Test Reports** — per-phase test runs and trend table: https://app.notion.com/p/353de14e04cc8165b50dc1fd46a900d0
- **Custom MCP Connection guide** — the JSON-RPC + CORS + auth template these workers follow: https://app.notion.com/p/33bde14e04cc8182b241d18c34fc9794

If a Notion doc and this README disagree, Notion wins. Update the README.

---

# Forking this for your own CDN

Stand up your own instance from this codebase. Assumes you have:

- A Cloudflare account (the free tier is enough)
- A domain on Cloudflare DNS (or skip the custom-domain steps and use the default `*.workers.dev` URL)
- Node 20+, npm, git
- The Wrangler CLI: `npm install -g wrangler`

## 1. Clone + install

```bash
git clone <this-repo-url> cdn-mcp
cd cdn-mcp
npm install
```

## 2. Authenticate Wrangler

```bash
npx wrangler login
npx wrangler whoami     # confirm the right account
```

## 3. Update `wrangler.toml` for your account

Open `wrangler.toml` and replace the following:

- `account_id` — your Cloudflare account ID. Find it in the Cloudflare dashboard right sidebar after selecting any zone.
- `[vars] PUBLIC_URL_PREFIX` — the public URL prefix for your assets. If you'll bind R2 to a custom domain (recommended; see step 6), use `https://cdn.<your-domain>`. Otherwise temporarily use a placeholder; you can update later.
- `[[d1_databases]] database_id` — leave the placeholder for now; you'll fill it in after step 4.
- `route` block — keep it commented out for now. Uncomment in step 7.

## 4. Create R2 bucket + D1 database

```bash
# R2 bucket — bytes live here
npx wrangler r2 bucket create cdn-assets

# D1 database — metadata source of truth
npx wrangler d1 create cdn-db
# Copy the returned database_id and paste into wrangler.toml's database_id field

# Apply the initial schema migration
npx wrangler d1 migrations apply cdn-db --remote
```

## 5. Set the MCP shared secret

The MCP auth token sits in the URL path because Claude's Custom Connectors don't support custom headers. Generate a strong random one:

```bash
TOKEN=$(openssl rand -hex 32)
echo "$TOKEN" | npx wrangler secret put MCP_AUTH_TOKEN
echo "Save this somewhere safe — you'll need it for the connector URL: $TOKEN"
```

You can rotate this any time later: re-run `wrangler secret put` with a new value, then update the connector URL in Claude.

## 6. (Optional) Bind a custom domain to R2 for branded asset URLs

In the Cloudflare dashboard → R2 → `cdn-assets` → Settings → Custom Domains → **Connect Domain**:
1. Enter the subdomain you chose (e.g. `cdn.your-domain.com`).
2. Cloudflare auto-creates the necessary CNAME on your zone.
3. Wait ~2 minutes for the SSL cert to provision.

Skip this step if you're OK with the default `pub-xxxxx.r2.dev` URL.

## 7. (Optional) Bind a custom Worker route for the MCP API

Decide on the hostname for the MCP API (e.g. `cdn-mcp.your-domain.com`).

In `wrangler.toml`:
- Uncomment the `route` block.
- Set `pattern` to `<your-host>/*`.
- Set `zone_id` to your zone's ID (Cloudflare dashboard → your domain → Overview → right sidebar).

In the Cloudflare dashboard → your domain → DNS → Records → **Add record**:
- Type: A
- Name: `cdn-mcp` (or whatever subdomain you chose)
- IPv4 address: `192.0.2.1` (TEST-NET-1 — never reached; Cloudflare's edge intercepts via the Worker route)
- Proxy status: Proxied (orange cloud)

Skip this step if you'll use the workers.dev URL.

## 8. (Optional) Phase 4 prerequisites — large-file uploads via signed URLs

If you'll use `cdn_signed_upload_url` to upload files larger than ~100MB:

```bash
# In Cloudflare dashboard → R2 → Manage R2 API Tokens → Create API Token
# Permissions: Object Read & Write
# Specify bucket: cdn-assets
# Copy the Access Key ID and Secret Access Key (shown only once)

echo "<your-access-key-id>"     | npx wrangler secret put R2_ACCESS_KEY_ID
echo "<your-secret-access-key>" | npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret list   # expect: MCP_AUTH_TOKEN, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
```

For real browser uploads (vs. curl), enable CORS on the bucket. Cloudflare dashboard → R2 → `cdn-assets` → Settings → CORS Policy → Add:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

(`AllowedOrigins: ["*"]` is fine for a personal CDN. Tighten if you want to lock to a specific frontend domain.)

## 9. Deploy

```bash
npx tsc --noEmit                 # typecheck clean
npm test                         # 70+ synthetic tests pass
npx wrangler whoami              # right account
npx wrangler secret list         # MCP_AUTH_TOKEN (and optionally R2 keys) present
npm run deploy
```

## 10. Smoke-test

Replace `<host>` with your route from step 7 (e.g. `cdn-mcp.your-domain.com`) or your `cdn-mcp.<subdomain>.workers.dev` URL if you skipped step 7. Replace `<token>` with the token from step 5.

```bash
# Health check
curl -s https://<host>/health
# Expect: {"status":"ok","service":"cdn-mcp","version":"0.1.0-phase4.1",...}

# MCP initialize
curl -s -X POST "https://<host>/mcp/<token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# Expect: HTTP 200, serverInfo JSON, protocolVersion "2024-11-05"

# tools/list — should list all 12 tools
curl -s -X POST "https://<host>/mcp/<token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq '.result.tools | length'
# Expect: 12
```

Only after curl returns the expected results, add the connector in Claude:

1. claude.ai → Settings → Customize → Connectors → **Add custom connector**.
2. URL: `https://<host>/mcp/<token>`
3. Verify all 12 tools appear in any Cowork session.

You're live.

---

# Daily-use deploy hygiene checklist

Run on every deploy (after the initial setup):

```bash
npx tsc --noEmit                 # 1. typecheck clean
npm test                         # 2. tests pass
npx wrangler whoami              # 3. right account
npx wrangler secret list         # 4. secrets present (silent miss = silent 404 in prod)
npm run deploy                   # 5. ship
curl -s https://<host>/health    # 6. smoke
# 7. MCP initialize curl
# 8. Only then: refresh the connector in Claude if needed
```

Each step has bitten us at least once. Skip none.

## Useful one-liners

```bash
openssl rand -hex 32                # generate a fresh MCP_AUTH_TOKEN for rotation
npx wrangler tail                   # live Worker logs while debugging
npx wrangler d1 execute cdn-db \
  --remote --command "SELECT * FROM files;"   # quick metadata peek
npx wrangler d1 execute cdn-db \
  --remote --command "SELECT name, file_count, total_size_bytes FROM (SELECT project AS name, COUNT(*) AS file_count, SUM(size_bytes) AS total_size_bytes FROM files GROUP BY project);"
```

## Repo layout

```
cdn-mcp/
├── README.md                      ← you are here
├── wrangler.toml                  ← Worker config: R2 + D1 bindings, vars, route
├── package.json                   ← scripts: dev / deploy / tail / typecheck / test
├── tsconfig.json                  ← strict, ES2022, @cloudflare/workers-types
├── tsconfig.test.json
├── .gitignore
├── src/
│   ├── index.ts                   ← Worker entry: routing, CORS preflight, /health, /mcp/<token>
│   ├── cors.ts                    ← CORS headers + helpers
│   ├── types.ts                   ← Env, Tool, ToolResult, JSON-RPC envelopes
│   ├── sigv4.ts                   ← AWS SigV4 presigning for R2 (Phase 4)
│   ├── mcp/
│   │   ├── dispatch.ts            ← JSON-RPC 2.0 dispatcher (initialize, tools/list, tools/call)
│   │   ├── upload.ts              ← performUpload + commitFileMetadata (shared write-side)
│   │   ├── util.ts                ← validators, MIME inference, cursor codec, DEFAULT_CACHE_CONTROL
│   │   └── tools/
│   │       ├── index.ts           ← TOOLS registry (source of truth for tool surface)
│   │       ├── _stub.ts           ← Phase 0 stub handler factory
│   │       └── cdn_*.ts           ← per-tool handlers (12 files)
│   └── db/
│       └── migrations/
│           └── 0001_init.sql      ← projects + files tables, indexes
└── test/
    ├── _mock.ts                   ← in-memory D1 + R2 mocks (shared)
    ├── sanity.ts                  ← registry shape + dispatcher round-trip
    ├── phase1.ts                  ← upload, list, list_projects, create_project
    ├── phase2.ts                  ← replace, delete (+ refactor regression check)
    ├── phase3.ts                  ← get_file, get_stats
    └── phase4.ts                  ← signed_upload_url, finalize_upload, sigv4 shape
```

## Architectural choices worth knowing about

These are decisions that took deliberation and might surprise you reading the code cold:

- **R2 first, then D1, on writes.** If R2 PUT fails, no D1 row. If D1 fails after R2 succeeds (rare), best-effort R2 cleanup on new uploads, accept orphaned-bytes-with-stale-metadata on replaces. Documented in `src/mcp/upload.ts`.
- **`cdn_finalize_upload` does NOT verify content_type matches `R2Object.httpMetadata.contentType`.** Caught one specific class of client bug, costs an extra D1↔R2 consistency check. Re-evaluate if mismatches surface in production. (See "Deferred trade-offs" in the Build Plan.)
- **`cdn_get_file` is permissive, `cdn_get_stats({project})` is strict.** Identity getters collapse miss reasons (`file_not_found` covers all of them); scope getters are loud about no-such-scope (`project_not_found` instead of silent zeros).
- **Cache-Control: `public, max-age=60` is baked in** at upload + presign time. Replaces become visible at the public URL within ~60s. Tunable via `DEFAULT_CACHE_CONTROL` in `src/mcp/util.ts`.
- **`required_headers` always returns an object** (possibly empty) so callers don't have to null-check.
- **The two remaining stubs (`cdn_rename_file`, `cdn_set_cache_headers`) are cosmetic.** Rename works via upload-new + delete-old; cache-headers work via the global default. Keep them stubbed unless a real need surfaces.

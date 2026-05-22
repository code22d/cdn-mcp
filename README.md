# cdn-mcp

A personal CDN backed by Cloudflare R2 (bytes), Cloudflare D1 (metadata), and a Cloudflare Worker that exposes everything as an MCP server. Upload images, videos, HTML files, or any other assets, organized into projects, and manage them from inside Claude (or any MCP client) via natural-language tool calls. Public URLs are stable — they don't change when you replace an asset.

Built phase-by-phase using a head-session/builder-session orchestration pattern. See the Notion docs below for the full design + decision history.

## Status

**Currently shipping Worker `0.1.0-phase5a`, plugin `v0.3.1`, cdn-cli `v0.1.0`. 11 of 13 tools have real handlers; 2 remain cosmetic stubs (`cdn_rename_file`, `cdn_set_cache_headers`).**

| Phase | Status | What shipped |
|---|---|---|
| 0 | ✅ | Scaffold + parity stubs for all 12 tools |
| 1 | ✅ | `cdn_upload_file`, `cdn_list_files`, `cdn_list_projects`, `cdn_create_project` |
| 2 | ✅ | `cdn_replace_file`, `cdn_delete_file` (+ `performUpload` refactor) |
| 3 | ✅ | `cdn_get_file`, `cdn_get_stats` |
| 4 | ✅ | `cdn_signed_upload_url`, `cdn_finalize_upload` (large-file uploads via SigV4) |
| 4.1 | ✅ | Cache-Control bake-in for fresh-on-replace + aws4fetch unsignable-headers fix |
| 5.0a | ✅ | `cdn_help` tool (13th in registry) + tool description hardening |
| 5.5 | ✅ | `cdn-file-upload` skill for sandbox-aware uploads |
| 6 | ✅ | `@22d/cdn-cli` v0.1.0 — local CLI for large/batch uploads |
| 6.1 | ✅ | cdn-cli distribution via GitHub Release tarballs (fixes global install) |
| 7 | ✅ | Cowork plugin packaging — `cdn-mcp-plugin` v0.1.0 |
| 8 | ✅ | Skill simplification — Path E becomes dominant; plugin v0.2.0 |
| 8.1 | ✅ | Clickable upload scripts (cross-platform `.command` / `.sh` / `.bat`); plugin v0.3.0 |
| 8.2 | ✅ | `chmod +x` clickable scripts before `present_files`; plugin v0.3.1 |
| 9 | ✅ | Partner-onboarding docs (`PARTNER-SETUP.md` + `INSTALL-WITH-CLAUDE.md`), README refresh |

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
| `cdn_help` | Surface tool-surface guidance to MCP clients (which tool when, common pitfalls). | ✅ |

## Where to look for canonical docs

This README is the operational quick-start. Decisions, architecture rationale, head-session pre-flight rules, and per-phase test reports live in Notion:

- **Build Plan** — stack, architecture, tool surface, head-session pre-flight checklist, deferred trade-offs, task tracker: https://app.notion.com/p/353de14e04cc8115b0e1eacac6c7b432
- **Test Reports** — per-phase test runs and trend table: https://app.notion.com/p/353de14e04cc8165b50dc1fd46a900d0
- **Custom MCP Connection guide** — the JSON-RPC + CORS + auth template these workers follow: https://app.notion.com/p/33bde14e04cc8182b241d18c34fc9794

If a Notion doc and this README disagree, Notion wins. Update the README.

---

# Setting up your own personal CDN

Stand up your own instance under your Cloudflare account, your domain, your R2 bucket. Two paths:

1. **Guided install via Claude Code** (recommended, ~80% automated) — paste **[INSTALL-WITH-CLAUDE.md](./INSTALL-WITH-CLAUDE.md)** into a fresh Claude Code session. Claude handles installs, deployment, and configuration; you click through a few Cloudflare dashboard screens.
2. **Manual walkthrough** — **[PARTNER-SETUP.md](./PARTNER-SETUP.md)** has every command and click written out. Pick this if you don't use Claude Code, or you want to understand what's happening at each step.

Both take ~30–60 minutes including DNS propagation. After setup you have your own CDN at `cdn.your-domain.com` (or `pub-xxx.r2.dev`), MCP-controllable from Cowork.

---

# Daily-use deploy hygiene checklist

Run on every deploy (after the initial setup):

```bash
npx tsc --noEmit                 # 1. typecheck clean
npm test                         # 2. tests pass
npx wrangler whoami              # 3. right account
npx wrangler secret list         # 4. secrets present (silent miss = silent 404 in prod)
npm run deploy                   # 5. ship to Cloudflare
curl -s https://<host>/health    # 6. smoke (expect new version in response)
# 7. MCP initialize curl
git status                       # 8. confirm working copy isn't drifting from what just shipped
git add -A                       # 9. stage all phase changes
git commit -m "feat: ..."        # 10. commit with phase / change summary
git push                         # 11. ship to GitHub (source = deployed code)
# 12. Only then: refresh the connector in Claude if needed
```

Each step has bitten us at least once. Skip none.

**Why steps 8–11 are non-optional:** Phase 5.0a deployed cleanly to Cloudflare 2026-05-04 but the code never made it to GitHub for two days. We caught it during the cdn-file-upload skill push when `git status` revealed 10 modified files + 3 untracked files from the previous deploy. Source-on-GitHub and code-on-Cloudflare must move together; otherwise next-builder picks up an out-of-date repo and either re-implements changes or merges over deployed work. The 30 seconds it costs to commit + push is worth the alternative.

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
│   ├── mcp/
│   │   ├── dispatch.ts            ← JSON-RPC 2.0 dispatcher (initialize, tools/list, tools/call)
│   │   ├── sigv4.ts               ← AWS SigV4 presigning for R2 (Phase 4)
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

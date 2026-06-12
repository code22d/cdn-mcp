# cdn-setup skill v0.2.0

Substantive rewrite driven by Andrew Lane's 5/22/26 install postmortem and the Phase 11 + 11.1 Worker ship (OAuth 2.1 + DCR + Streamable HTTP + confidential client) that made the claude.ai Custom Connector work again.

## What changed

- **Custom Connector restored (Phase E is back).** Phase 11/11.1 fixed the claude.ai side; the skill now walks partners through adding the connector at claude.ai/customize/connectors with their Worker URL + OAuth Client ID/Secret in Advanced settings. Partners get all 13 cdn_* tools in any Cowork session.
- **OAuth credentials baked into the Phase C deploy.** The deploy script now generates and sets three Worker secrets — `MCP_AUTH_TOKEN`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` — and includes all three in the structured pasteback block. The skill captures them and reminds the partner to save the OAuth pair for Phase E.
- **Postmortem fixes:**
  - **Fully manual Cloudflare flow.** No more Chrome MCP attempts — Cloudflare's dashboard blocks automated browsers. Every dashboard step is a direct URL (account-id interpolated) with pre-warnings about the gotchas: the R2 "Purchase Plan" $0.00 card gate, the R2-specific API tokens page, Account API token vs User API token, and leaving IP filtering blank.
  - **Mount-aware plugin download.** The Phase D script downloads the `.plugin` into the partner's Cowork-mounted folder (auto-detected from session context, asked for if not) instead of `~/Downloads`, which the sandbox can't reach. A `03b-copy-plugin-to-mount` fallback script covers the ~/Downloads case.
  - **Explicit fresh-session boilerplate** after the plugin install — newly installed skills don't hot-reload; the partner is told to open a fresh session before the smoke test, every time.
- **Plugin reference bumped to plugin-v0.4.0** (Path E clickable-script uploads for every file size + filename sanitization). The Phase F smoke test reflects the new upload flow.
- **Optional debug script** — `99-wrangler-tail.command` live-streams Worker logs for diagnosing deploy or connector issues. Offered on request only, never auto-run.

## Six phases (A–F)

- **A** — Cloudflare account + R2 + domain + optional R2 keys + Cowork-mounted folder (manual, direct URLs)
- **B** — Install prereqs (Node 20 / git / gh / wrangler) via clickable .command script
- **C** — Deploy Worker via clickable script: 3 secrets set, smoke test, structured pasteback (+ optional C.5/C.6 for custom domains)
- **D** — Install cdn-cli + download plugin v0.4.0 to the mounted folder via clickable script
- **E** — Add claude.ai Custom Connector with OAuth Client ID + Secret (manual)
- **F** — Install plugin via present_files + smoke test in a fresh Cowork session

State lives in chat across phases; partner can pause and resume. Mac is the primary tested platform; Linux is symmetric; Windows is partial (CLI install + config-write only; prereqs are manual).

## Install

```bash
gh release download cdn-setup-v0.2.0 --repo code22d/cdn-mcp --pattern "*.skill" --dir ~/Downloads
```

Then in Cowork: ask Claude to install the skill from `~/Downloads/cdn-setup.skill`. Cowork's `present_files` will render a card; click Save.

Open a fresh Cowork session and say "set me up with my own CDN" to start.

## Requires

- Cowork (claude.ai/cowork or desktop)
- A Cloudflare account (free tier OK; credit card required for R2 subscription even on free)
- A deployed Worker running `0.1.0-phase11.1` or later (the deploy script clones main, so fresh installs get this automatically)
- ~30–60 minutes
- Optional: a domain on Cloudflare DNS for branded URLs

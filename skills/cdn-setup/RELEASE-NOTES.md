# cdn-setup skill v0.1.0

First release of the Cowork-native guided installer for personal cdn-mcp deployments. Replaces the prior Claude-Code-based `INSTALL-WITH-CLAUDE.md` and manual `PARTNER-SETUP.md` flows.

## What it does

Six-phase guided setup inside a Cowork session:
- **A** — Cloudflare account + R2 + domain setup (Chrome MCP w/ manual fallback)
- **B** — Install prereqs (Node 20 / gh / wrangler) via clickable .command script
- **C** — Deploy Worker via clickable script (+ optional 02b for custom-domain rebind)
- **D** — Install cdn-cli + download plugin via clickable script
- **E** — Add Cowork custom connector (Chrome MCP w/ manual fallback)
- **F** — Install plugin + smoke test in fresh Cowork session

State lives in chat across phases; partner can pause and resume. Mac is the primary tested platform; Linux is symmetric; Windows is partial (CLI install + config-write only; prereqs are manual).

## Install

```bash
gh release download cdn-setup-v0.1.0 --repo code22d/cdn-mcp --pattern "*.skill" --dir ~/Downloads
```

Then in Cowork: ask Claude to install the skill from `~/Downloads/cdn-setup.skill`. Cowork's `present_files` will render a card; click Save.

Open a fresh Cowork session and say "set me up with my own CDN" to start.

## Requires
- Cowork (claude.ai/cowork or desktop)
- A Cloudflare account (free tier OK; credit card required for R2 subscription even on free)
- ~30–60 minutes
- Optional: a domain on Cloudflare DNS for branded URLs

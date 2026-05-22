# CDN w MCP — Cowork Plugin

This plugin installs the `cdn-file-upload` skill, which gives Cowork sessions
operational know-how for uploading files to a personal CDN built on Cloudflare
R2 + Workers + D1. The skill picks the right transport (direct base64, subagent
fan-out, local CLI, or signed-URL `.command` script) based on file size, batch
size, and quality preferences.

This plugin doesn't bundle the CDN itself — the Worker and the CLI have their
own install paths, referenced below.

## Required setup before this plugin is useful

Before the skill can actually upload anything, you need a deployed CDN of your
own. The plugin teaches Cowork sessions how to use yours; it doesn't deploy
infrastructure.

### 1. Deploy your own cdn-mcp Worker

Follow the setup walkthrough in the cdn-mcp repo README:
https://github.com/code22d/cdn-mcp#forking-this-for-your-own-cdn

That gets you: an R2 bucket, a D1 database, a Cloudflare Worker exposing the
MCP, a custom domain for public assets, and an `MCP_AUTH_TOKEN` secret.

### 2. Add your MCP connector to Cowork

claude.ai → Settings → Customize → Connectors → Add custom connector.

URL: `https://cdn-mcp.<your-domain>/mcp/<your-MCP_AUTH_TOKEN>`

Verify all 13 tools (`cdn_upload_file`, `cdn_list_files`, `cdn_signed_upload_url`,
`cdn_finalize_upload`, `cdn_help`, etc.) appear in any Cowork session.

### 3. (Optional but recommended) Install the local CLI

For uploads >50MB or batch uploads where Cowork would have to write a
`.command` script for you to double-click, install the companion CLI:

```bash
gh release download v0.1.0 \
  --repo code22d/cdn-cli \
  --pattern "*.tgz" \
  --dir /tmp
npm install -g /tmp/22d-cdn-cli-0.1.0.tgz
rm /tmp/22d-cdn-cli-0.1.0.tgz
cdn version  # should print 0.1.0
```

Then create `~/.cdn-cli/config.json` with your R2 access keys + MCP token. See
the cdn-cli README for the config schema.

The skill auto-detects the CLI when installed and prefers it over the
sandbox-bound `.command` file flow. No skill edits needed — Path E activates
automatically.

## What the skill does (after setup)

When you ask Cowork to "upload `<files>` to the CDN", the skill picks the
right transport based on file size and session context:

| Path | When | How |
|---|---|---|
| **A** — direct base64 | Small files (<1 MB), or single file 1–3 MB | `cdn_upload_file` from the parent session |
| **B** — subagent fan-out | Medium files (1–3 MB), batches >5 files | One subagent per file; parent only sees URLs |
| **C** — signed URL + `.command` | Files >3 MB where quality matters | Generates `.command` script you double-click to run `curl` from your local terminal |
| **D** — compress then base64 | Images >3 MB where web-optimized is fine | Pillow → 1920px JPEG q85 → Path A or B |
| **E** — local CLI | Any size, CLI installed | `cdn upload <project> <file>` (preferred when available) |

See `~/.claude/skills/cdn-file-upload/SKILL.md` (installed by this plugin) for
the full decision tree, error handling, and sample interactions.

## Components

| Component | Purpose |
|---|---|
| **Skill** (`cdn-file-upload`) | Decision tree + transport patterns for uploading files of any size to the personal CDN |

No commands, no MCP servers, no agents, no hooks. The plugin is pure skill +
docs. The MCP connector is added separately (step 2 above).

## Versioning

This plugin's version (in `plugin.json`) tracks independently from the
cdn-mcp Worker (`0.1.0-phase5a`) and the cdn-cli (`v0.1.0`). Plugin `v0.1.0`
is the first release.

Future plugin releases are tagged as `plugin-vX.Y.Z` on the cdn-mcp repo to
distinguish them from Worker versions like `v0.1.0-phase5a`.

## Install

```bash
gh release download plugin-v0.1.0 \
  --repo code22d/cdn-mcp \
  --pattern "*.plugin" \
  --dir /tmp
```

Then double-click `/tmp/cdn-mcp-plugin.plugin` to install in Cowork.

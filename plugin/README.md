# CDN w MCP — Cowork Plugin

This plugin installs the `cdn-file-upload` skill, which gives Cowork sessions
operational know-how for uploading files to a personal CDN built on Cloudflare
R2 + Workers + D1. Every upload goes through a clickable script that runs the
local `cdn` CLI on your machine — no size limits, no base64 round-trips. The
MCP connector is still used for metadata and post-upload verification.

This plugin doesn't bundle the CDN itself — the Worker and the CLI have their
own install paths, referenced below.

## What changed in v0.4.0

v0.4.0 (2026-06-11): The cdn-file-upload skill now uses Path E (clickable
script + local CLI) for all uploads regardless of file size. Path A
(base64-over-MCP) removed. Plus auto-sanitizes filenames with spaces or
special characters before uploading; partners are shown the proposed clean
name and can override before the script runs.

## What changed in v0.3.1

- **Skill now `chmod +x`'s clickable scripts before surfacing them.** Fixes the
  "could not be executed because you do not have appropriate access privileges"
  error users hit when double-clicking `.command`/`.sh` files from earlier
  v0.3.x builds.

## What changed in v0.2.0

- **Skill defaults to the CLI for any file > 1 MB.** Earlier versions had a
  5-path decision tree with broken auto-detection; the CLI path was never
  actually firing.
- **Subagent fan-out and auto-compression removed from routing.** Compression
  is still available on request; subagent gymnastics aren't needed now that
  the CLI handles any size.
- **The `.command` file flow is demoted to a fallback** for users who haven't
  installed the CLI yet, rather than the default for large files.

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

- **Remote MCP server URL:** `https://cdn-mcp.<your-domain>/mcp`
- **Advanced settings → OAuth Client ID / Client Secret:** the
  `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` values from your Worker deploy
  (the cdn-setup skill generates and walks you through these).

Verify all 13 tools (`cdn_upload_file`, `cdn_list_files`, `cdn_signed_upload_url`,
`cdn_finalize_upload`, `cdn_help`, etc.) appear in any Cowork session.

### 3. Install the local CLI (required for all uploads)

Every upload runs through the CLI via the skill's clickable script — there is
no MCP fallback path anymore. Install it once:

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

The skill assumes the CLI is installed and generates the upload script
straight away. If `cdn: command not found` comes back from your terminal, the
skill re-prints the install command above and you re-run the same script.

## What the skill does (after setup)

When you ask Cowork to "upload `<files>` to the CDN", the skill generates a
clickable upload script (`.command` on macOS, `.sh` on Linux, `.bat` on
Windows) that runs the local `cdn` CLI — for every upload, regardless of
size. You double-click the script; it streams the bytes to R2 and verifies
the public URL; the skill confirms via `cdn_get_stats` after you report back.

If the filename contains characters that don't URL-encode cleanly (spaces,
parens, unicode, etc.), the skill proposes a sanitized name first — you can
accept it or supply your own before the script is generated.

If the CLI isn't installed yet, the script's terminal output says so plainly
and the skill walks you through the one-time install, then you re-run the
same script.

Compression is opt-in: if you ask the skill to compress images first, it will;
otherwise the originals are preserved regardless of size.

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
cdn-mcp Worker (`0.1.0-phase11.1`) and the cdn-cli (`v0.1.0`). Current release:
`plugin-v0.4.0` (Path E only; filename sanitization).

Plugin releases are tagged as `plugin-vX.Y.Z` on the cdn-mcp repo to
distinguish them from Worker versions like `v0.1.0-phase5a`.

## Install

macOS has no file association for `.plugin`, so double-clicking in Finder
doesn't trigger an install. The working flow is to surface the file inside a
Cowork session so its built-in file card shows the **Save** button — that
button is the actual installer.

1. **Download the .plugin** to a Cowork-accessible folder:

   ```bash
   gh release download plugin-v0.4.0 \
     --repo code22d/cdn-mcp \
     --pattern "*.plugin" \
     --dir /tmp
   ```

   `/tmp` works because Cowork can read it; any folder you've granted Cowork
   access to via the folder picker also works.

2. **In a Cowork session, ask Claude to install it** — e.g.
   *"install the plugin at `/tmp/cdn-mcp-plugin.plugin`"*. Claude calls
   `present_files` to surface the file in chat. The resulting file card has a
   **Save** button.

3. **Click Save.** Cowork installs the plugin into your account.

4. **Open a fresh Cowork session.** The `cdn-file-upload` skill appears at the
   top of the available-skills list with the description *"Upload files of any
   size or type to Rene's personal CDN at cdn.22d.app via the cdn-mcp
   connector."*

The flow is one extra step compared to double-click but it's the path that
works today. If you find a smoother install surface in your Cowork build,
let us know.

# CDN w MCP — Cowork Plugin

This plugin installs the `cdn-file-upload` skill, which gives Cowork sessions
operational know-how for uploading files to a personal CDN built on Cloudflare
R2 + Workers + D1. For trivially small files (≤ 1 MB) the skill uploads
directly through the MCP; for anything larger it prints a `cdn upload` command
for you to run via the local CLI. A signed-URL `.command` script is offered as
a fallback if the CLI isn't installed yet.

This plugin doesn't bundle the CDN itself — the Worker and the CLI have their
own install paths, referenced below.

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

URL: `https://cdn-mcp.<your-domain>/mcp/<your-MCP_AUTH_TOKEN>`

Verify all 13 tools (`cdn_upload_file`, `cdn_list_files`, `cdn_signed_upload_url`,
`cdn_finalize_upload`, `cdn_help`, etc.) appear in any Cowork session.

### 3. Install the local CLI (required for non-trivial uploads)

The skill defaults to the CLI for anything larger than ~1 MB. Without it, the
skill falls back to a `.command` script you have to double-click for every
upload — workable for day-1 partners, but the CLI is the smooth path. Install
it once:

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

The skill assumes the CLI is installed and prints a `cdn upload` command for
the user to run. If `cdn: command not found` comes back, the skill falls back
to the `.command` script flow and re-prints the install command above.

## What the skill does (after setup)

When you ask Cowork to "upload `<files>` to the CDN", the skill picks the
right transport based on file size:

| Path | When | How |
|---|---|---|
| **A** — direct base64 (MCP) | Single file ≤ 1 MB and batch ≤ 10 files | `cdn_upload_file` from the parent session — zero friction, no terminal needed |
| **E** — local CLI (default) | Anything else | Skill prints `cdn upload <project> <abs-path>` (or `cdn upload-dir …`); you run it in your terminal; skill verifies via `cdn_get_stats` |
| **C** — signed URL + `.command` (fallback) | CLI not installed | Generates a `.command` script you double-click to run `curl` from your local terminal — and prints the install command so the next upload skips this step |

Compression is opt-in: if you ask the skill to compress images first, it will;
otherwise Path E preserves the originals regardless of size.

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
cdn-mcp Worker (`0.1.0-phase5a`) and the cdn-cli (`v0.1.0`). Current release:
`plugin-v0.2.0` (simplified routing; CLI-first by default).

Plugin releases are tagged as `plugin-vX.Y.Z` on the cdn-mcp repo to
distinguish them from Worker versions like `v0.1.0-phase5a`.

## Install

macOS has no file association for `.plugin`, so double-clicking in Finder
doesn't trigger an install. The working flow is to surface the file inside a
Cowork session so its built-in file card shows the **Save** button — that
button is the actual installer.

1. **Download the .plugin** to a Cowork-accessible folder:

   ```bash
   gh release download plugin-v0.2.0 \
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

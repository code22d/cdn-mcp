# Stand up your own personal CDN on Cloudflare

End-to-end walkthrough for getting your own clone of this project running: a CDN backed by Cloudflare R2 + Workers + D1, with an MCP server, a local CLI, and a Cowork plugin. ~30–60 minutes start to finish.

There are two paths:

1. **Guided install via Claude Code** (recommended, ~80% automated) — see [INSTALL-WITH-CLAUDE.md](./INSTALL-WITH-CLAUDE.md). Paste the prompt into a Claude Code session and it handles installs, configuration, and deployment for you. You'll still click through a few Cloudflare dashboard screens.
2. **Manual install** (this doc) — every command, every click, written out. Pick this if you don't want to use Claude Code, or if you want to understand what's happening at each step.

---

## Table of contents

- [What you're getting](#what-youre-getting)
- [Architecture overview](#architecture-overview)
- [Part 0 — what you need before starting](#part-0--what-you-need-before-starting)
- [Part 1 — deploy your cdn-mcp Worker](#part-1--deploy-your-cdn-mcp-worker)
- [Part 2 — install and configure the local CLI](#part-2--install-and-configure-the-local-cli)
- [Part 3 — add your Worker as a Cowork connector](#part-3--add-your-worker-as-a-cowork-connector)
- [Part 4 — install the Cowork plugin](#part-4--install-the-cowork-plugin)
- [Smoke test — your first upload](#smoke-test--your-first-upload)
- [You're live. What you have now.](#youre-live-what-you-have-now)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)

---

## What you're getting

A personal content delivery network under your own domain (or default Cloudflare URLs if you skip custom-domain steps). Bytes live in Cloudflare R2 (S3-compatible object storage), metadata lives in Cloudflare D1 (SQLite at the edge), and a Cloudflare Worker exposes everything as a Model Context Protocol (MCP) server. Public URLs are stable — they don't change when you replace an asset.

From inside Cowork, you can say *"upload this image to project blog on the CDN"* and Claude does the right thing. A companion CLI (`cdn upload`) handles files too large for the MCP base64 round-trip. There's also a Cowork plugin that bundles a `cdn-file-upload` skill so the upload routing is automatic.

This is the same setup used at [cdn.22d.app](https://cdn.22d.app). Free tier on Cloudflare handles personal use (10 GB R2 storage, 1M Class A ops, 10M Class B ops per month).

## Architecture overview

Four pieces, your own copy of each:

```
┌─────────────────────────────────────────────────────────────────┐
│  Your computer                                                  │
│                                                                 │
│  ┌─────────────┐   ┌────────────────────┐                       │
│  │  Cowork +   │   │  @22d/cdn-cli      │                       │
│  │  plugin     │   │  (local CLI)       │                       │
│  │             │   │                    │                       │
│  └──────┬──────┘   └────────┬───────────┘                       │
│         │ MCP JSON-RPC      │ R2 PUT (large files)              │
│         │                   │ + MCP finalize                    │
└─────────┼───────────────────┼───────────────────────────────────┘
          │                   │
          ▼                   ▼
    ┌──────────────────────────────────────┐
    │  Your Cloudflare account             │
    │                                      │
    │  ┌────────────────┐  ┌────────────┐  │
    │  │ cdn-mcp Worker │──│ D1 (meta)  │  │
    │  │ (the brain)    │  └────────────┘  │
    │  │                │  ┌────────────┐  │
    │  │                │──│ R2 (bytes) │──┐
    │  └────────────────┘  └────────────┘  │  ← public CDN URL
    │                                      │    cdn.your-domain.com
    └──────────────────────────────────────┘    or pub-xxx.r2.dev
```

- **cdn-mcp Worker** (Cloudflare Worker): 13 MCP tools — upload, list, replace, delete, get, stats, signed URLs for large uploads, plus an in-Worker help tool. The brain; talks to R2 and D1.
- **R2 bucket + D1 database** (Cloudflare): your files' bytes + their metadata. Bytes are publicly readable at `cdn.your-domain.com/<project>/<filename>` (or `pub-xxx.r2.dev/...` if you skip the custom domain).
- **@22d/cdn-cli** (local Node CLI): for files bigger than ~1 MB, the CLI streams direct from disk to R2 via signed URL, then calls the Worker to commit metadata. Bypasses the MCP base64 size limit.
- **cdn-mcp-plugin** (Cowork plugin): installs the `cdn-file-upload` skill. The skill watches for upload requests, picks the right transport (MCP for small / CLI for large), and verifies the upload landed.

The skill calls tools by name — `cdn_upload_file`, `cdn_finalize_upload`, etc. As long as your Cowork has a custom connector exposing those tools (added in Part 3 below), uploads route to *your* Worker → *your* R2 bucket. **The plugin doesn't embed anyone else's URL.**

## Part 0 — what you need before starting

### Accounts (sign up via web)

- **Cloudflare account** — https://dash.cloudflare.com/sign-up. Free tier is enough for personal use.
- **GitHub account** — https://github.com/signup if you don't have one. Source code is at https://github.com/code22d/cdn-mcp and https://github.com/code22d/cdn-cli (both public).
- **Optional: a domain on Cloudflare DNS.** If you want clean URLs like `cdn.your-domain.com`, you need a domain you can move to Cloudflare's nameservers. Without one, you'll use the default `pub-xxxxx.r2.dev` URL — still works, just less pretty. Moving a domain to Cloudflare DNS takes 1–24h to propagate; do this first if you want a custom domain. Cloudflare's instructions: https://developers.cloudflare.com/dns/zone-setups/full-setup/.

### Tools (install via your terminal)

Skip any you already have. Run each install command, then verify with the `--version` check that follows.

**Node 20 or newer (includes npm):**
- macOS via Homebrew: `brew install node@20 && brew link --overwrite node@20`
- Or download installer: https://nodejs.org (LTS)
- Verify: `node --version` → `v20.x.x` or higher

**Git:**
- macOS: `brew install git` (usually pre-installed via Xcode Command Line Tools)
- Linux: `sudo apt install git` (Debian/Ubuntu) or your distro's equivalent
- Verify: `git --version`

**GitHub CLI:**
- macOS: `brew install gh`
- Linux: https://cli.github.com (apt / dnf instructions)
- Windows: `winget install --id GitHub.cli`
- Verify: `gh --version`
- Authenticate: `gh auth login` (follow the prompts — choose HTTPS, login via web browser)

**Wrangler (Cloudflare Workers CLI):**
- `npm install -g wrangler` — globally installed
- Verify: `wrangler --version` → should be 3.x or higher
- Authenticate: `wrangler login` (opens browser, you authorize)
- After auth: `wrangler whoami` → should show your Cloudflare email

Once all four commands return a version, you're ready for Part 1.

> **Permissions gotcha:** if `npm install -g wrangler` fails with `EACCES`, do NOT use `sudo`. Run `npm config set prefix '~/.npm-global'` and add `~/.npm-global/bin` to your PATH (in `.zshrc` or `.bashrc`: `export PATH="$HOME/.npm-global/bin:$PATH"`). Restart your terminal. Retry the install.

## Part 1 — deploy your cdn-mcp Worker

> **Never commit secrets.** Your `MCP_AUTH_TOKEN`, R2 access keys, and any other credentials live in Cloudflare (set via `wrangler secret put`) and on your machine — never in a file you push to a git remote. The `wrangler.toml` file you'll edit contains identifiers (account ID, database ID, bucket name) which are safe locally but should not be pushed to a public remote.

### 1.1 Clone the source

```bash
git clone https://github.com/code22d/cdn-mcp.git ~/cdn-mcp
cd ~/cdn-mcp
npm install
```

You're cloning the public source directly — no fork required for the default flow. If you plan to modify the code or want a personal GitHub backup of your config, fork on github.com first and clone your fork's URL instead.

Verify the typecheck and tests are green before deploying anything:

```bash
npx tsc --noEmit       # should exit 0 with no output
npm test               # should report all tests pass
```

### 1.2 Confirm Wrangler is logged in to the right account

```bash
wrangler whoami
```

If it shows the wrong account: `wrangler logout` then `wrangler login` and pick the right one.

### 1.3 Edit `wrangler.toml`

Open `~/cdn-mcp/wrangler.toml` in your editor of choice. Replace:

- **`account_id`** → your Cloudflare account ID. Find it at https://dash.cloudflare.com → right sidebar after selecting any zone (or visible in the URL when on the account-level dashboard).
- **`[vars] PUBLIC_URL_PREFIX`** → if you'll bind R2 to a custom domain (see 1.6), set to `"https://cdn.your-domain.com"`. Otherwise use a placeholder; we'll come back to it.
- **`[[d1_databases]] database_id`** → leave the placeholder for now. We fill this in step 1.4.
- **`[[r2_buckets]] bucket_name`** → `cdn-assets` (the default) or whatever name you prefer.
- **`route` block** → keep commented out for now. Uncomment in step 1.7 if using custom domain.

**Keep these edits local.** Don't push them to any remote.

### 1.4 Create R2 bucket and D1 database

```bash
# R2 bucket
npx wrangler r2 bucket create cdn-assets

# D1 database
npx wrangler d1 create cdn-db
# Output includes: database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
# Copy that database_id into wrangler.toml's [[d1_databases]] block

# Apply the initial schema migration
npx wrangler d1 migrations apply cdn-db --remote
# Should report "✓ Successfully applied 1 migration"
```

### 1.5 Generate and set the MCP auth token

The MCP auth token gets embedded in the connector URL (`/mcp/<token>`) — Claude's Custom Connectors don't support custom headers, so the secret lives in the URL path.

```bash
TOKEN=$(openssl rand -hex 32)
echo "$TOKEN" | npx wrangler secret put MCP_AUTH_TOKEN
echo "Save this somewhere safe: $TOKEN"
```

Copy the token output to your password manager or notes — you'll need it for the Cowork connector URL (Part 3) and the CLI config (Part 2).

You can rotate it later: `wrangler secret put MCP_AUTH_TOKEN` with a new value, then update the connector URL and CLI config.

### 1.6 (Optional) Bind a custom domain to R2 for branded asset URLs

Skip this whole step if you're OK with the default `pub-xxxxx.r2.dev` URL.

In the Cloudflare dashboard → R2 → your bucket → **Settings** → **Custom Domains** → **Connect Domain**:

1. Enter the subdomain you want (e.g., `cdn.your-domain.com`)
2. Cloudflare auto-creates the necessary CNAME on your zone
3. Wait ~2 minutes for the SSL certificate to provision
4. Verify with `curl -I https://cdn.your-domain.com` — should return a Cloudflare-served response

After this is live, update `wrangler.toml`'s `PUBLIC_URL_PREFIX` to `"https://cdn.your-domain.com"` if it wasn't already.

### 1.7 (Optional) Bind a custom Worker route for the MCP API

Skip if you'll use the workers.dev URL.

**In `wrangler.toml`:**
- Uncomment the `route` block
- Set `pattern` to `"cdn-mcp.your-domain.com/*"`
- Set `zone_id` to your zone's ID (Cloudflare dashboard → your domain → Overview → right sidebar)

**Add a DNS record** at Cloudflare dashboard → your domain → DNS → Records → **Add record**:
- Type: A
- Name: `cdn-mcp` (or whatever subdomain you chose)
- IPv4: `192.0.2.1` (TEST-NET-1 — never reached; Cloudflare's edge intercepts via the Worker route)
- Proxy status: **Proxied** (orange cloud)

### 1.8 (Optional, only if you'll upload files >100 MB) R2 API keys + CORS

Skip if you'll only ever upload small files via the MCP.

The CLI's large-file path uses an R2 signed URL to PUT bytes directly to the bucket, bypassing Worker request body limits. That requires R2 API credentials as Worker secrets.

**Create an R2 API token** at Cloudflare dashboard → R2 → **Manage R2 API Tokens** → **Create API Token**:
- Permissions: Object Read & Write
- Specify bucket: your bucket name
- Copy the Access Key ID AND Secret Access Key (shown only once; capture both immediately)

**Set them as Worker secrets:**

```bash
echo "<your-access-key-id>"     | npx wrangler secret put R2_ACCESS_KEY_ID
echo "<your-secret-access-key>" | npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret list
# Expected output includes: MCP_AUTH_TOKEN, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
```

**Enable CORS on the bucket** at R2 → your bucket → Settings → CORS Policy → Add:

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

(`AllowedOrigins: ["*"]` is fine for personal use. Tighten if you want to restrict origin.)

### 1.9 Deploy

```bash
cd ~/cdn-mcp
npx tsc --noEmit                    # typecheck clean
npm test                            # all tests pass
npx wrangler whoami                 # right Cloudflare account
npx wrangler secret list            # secrets present
npm run deploy
```

The deploy output tells you the Worker URL — either:
- `https://cdn-mcp.your-domain.com` (if 1.7 is live)
- `https://cdn-mcp.<account-subdomain>.workers.dev` (default)

### 1.10 Smoke test

Replace `<host>` and `<token>` with your values:

```bash
HOST="cdn-mcp.your-domain.com"   # or workers.dev URL
TOKEN="<your-MCP_AUTH_TOKEN>"

# Health check
curl -s "https://$HOST/health"
# Expect: {"status":"ok","service":"cdn-mcp","version":"0.1.0-phase5a",...}

# MCP initialize
curl -s -X POST "https://$HOST/mcp/$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# Expect: HTTP 200 with serverInfo JSON

# tools/list — should list all 13 tools
curl -s -X POST "https://$HOST/mcp/$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq '.result.tools | length'
# Expect: 13
```

Only after all three pass, continue to Part 2.

## Part 2 — install and configure the local CLI

### 2.1 Install

```bash
gh release download v0.1.0 --repo code22d/cdn-cli --pattern "*.tgz" --dir /tmp
npm install -g /tmp/22d-cdn-cli-0.1.0.tgz
rm /tmp/22d-cdn-cli-0.1.0.tgz

cdn version    # expect: 0.1.0
```

### 2.2 Configure

Create `~/.cdn-cli/config.json`:

```bash
mkdir -p ~/.cdn-cli
cat > ~/.cdn-cli/config.json <<EOF
{
  "mcp": {
    "url": "https://cdn-mcp.your-domain.com/mcp/<your-MCP_AUTH_TOKEN>"
  },
  "r2": {
    "accountId": "<your-cloudflare-account-id>",
    "accessKeyId": "<your-r2-access-key-from-step-1.8>",
    "secretAccessKey": "<your-r2-secret-from-step-1.8>",
    "bucket": "cdn-assets"
  },
  "publicUrlPrefix": "https://cdn.your-domain.com"
}
EOF
```

If you skipped step 1.8 (no R2 API keys), leave the `r2.accessKeyId` and `r2.secretAccessKey` as empty strings. The CLI's read-side commands (`cdn ls`, `cdn projects`, `cdn stats`) will still work; only `cdn upload` for large files will fail until you add them.

Environment variables can override any config field (`CDN_MCP_URL`, `CDN_R2_ACCOUNT_ID`, etc.) — see `cdn config --help`.

### 2.3 Verify

```bash
cdn projects
# Expect: empty list (you haven't uploaded anything yet)
```

If you get an error, check the URL in `~/.cdn-cli/config.json` matches your Worker URL + token exactly.

## Part 3 — add your Worker as a Cowork connector

Open https://claude.ai → Settings → Customize → **Connectors** → **Add custom connector**:

- **URL:** `https://cdn-mcp.your-domain.com/mcp/<your-MCP_AUTH_TOKEN>` — the same URL you set in `~/.cdn-cli/config.json`'s `mcp.url`
- **Name:** anything; `cdn-mcp` is conventional
- Save

Then verify: open any Cowork session, open the tool picker, and confirm 13 `cdn_*` tools appear (`cdn_help`, `cdn_upload_file`, `cdn_list_files`, ...).

Because the connector points to *your* Worker URL, any tool call routes to *your* CDN — not to anyone else's, even when the plugin (next step) is shared widely.

## Part 4 — install the Cowork plugin

### 4.1 Download

```bash
gh release download plugin-v0.3.1 --repo code22d/cdn-mcp --pattern "*.plugin" --dir ~/Downloads
ls -la ~/Downloads/cdn-mcp-plugin.plugin
# Expect: a ~17 KB .plugin file
```

### 4.2 Install in Cowork

Open a Cowork session and ask Claude:

> *"Install this plugin: `~/Downloads/cdn-mcp-plugin.plugin`"*

Cowork will use its `present_files` tool to show the .plugin as a card in the chat. Click **Save plugin** on the card. The plugin installs.

### 4.3 Verify

Open a **fresh** Cowork session (so the new skill loads). Type `/cdn-file-upload` — the skill should appear at the top of the menu. That confirms the plugin is installed and the skill is discoverable.

## Smoke test — your first upload

Make a small test file:

```bash
echo "hello from my new CDN" > /tmp/hello.txt
```

In a fresh Cowork session:

> *"Upload `/tmp/hello.txt` to project test on the CDN"*

The skill will:
1. Notice the file is < 1 MB → use Path A (MCP base64)
2. Upload via `cdn_upload_file`
3. Report the public URL: `https://cdn.your-domain.com/test/hello.txt`

Verify the file is live:

```bash
curl https://cdn.your-domain.com/test/hello.txt
# Expect: "hello from my new CDN"
```

(If using workers.dev: the URL will be `https://pub-<hash>.r2.dev/test/hello.txt`.)

**Try a large file to verify Path E (CLI clickable script):**

```bash
# Create a 2 MB test file
dd if=/dev/urandom of=/tmp/big.bin bs=1M count=2
```

In Cowork:

> *"Upload `/tmp/big.bin` to project test on the CDN"*

The skill should detect the file is > 1 MB and write a `.command` script. Double-click the script (Finder → it opens in Terminal), the script runs `cdn upload test /tmp/big.bin`, then `curl -sIf` HEAD-checks the public URL and prints `✓ Verified: https://...`. Press any key to close the Terminal window. Back in Cowork, say "done"; the skill confirms via `cdn_get_stats`.

If you get errors, see [Troubleshooting](#troubleshooting) below.

## You're live. What you have now.

- Public CDN at `cdn.your-domain.com` (or `pub-xxx.r2.dev`) — anyone with a URL can read your files
- Stable URLs: replacing a file keeps the same URL (no cache-bust needed; the Worker sets a 60s edge cache + R2 emits `Cache-Control: public, max-age=60`)
- 13 MCP tools accessible from any Cowork session via the connector you added
- Local `cdn` CLI for batch uploads, large files, scripted workflows
- Cowork plugin that auto-routes uploads to the right transport
- Cloudflare dashboard shows usage at R2 / D1 / Workers

Architecture details and design decisions are documented at the project's [Build Plan in Notion](https://app.notion.com/p/353de14e04cc8115b0e1eacac6c7b432). Daily-use commands and tool reference: [README.md](./README.md). Run `cdn help` for CLI commands.

## Updating

**cdn-mcp Worker:**

```bash
cd ~/cdn-mcp
git stash             # save your wrangler.toml edits
git pull origin main
git stash pop         # restore your edits (resolve any conflicts on wrangler.toml: keep yours)
npm install
npm test
npm run deploy
```

**cdn-cli:** re-run the `gh release download` from Part 2 with the new version tag. New CLI overwrites old.

**Plugin:** ask Claude in Cowork to install the new `.plugin` file from `gh release download plugin-v<new> ...`. Overwrites the old version.

Watch the project's [GitHub Releases](https://github.com/code22d/cdn-mcp/releases) for new versions.

## Troubleshooting

**"Plugin validation failed" when installing in Cowork**
The plugin's SKILL.md description exceeded Cowork's ~1024-char cap. If you're installing the official release (v0.3.1+) this shouldn't happen; if you forked and edited the skill, check the description length.

**".command" file double-click shows "could not be executed because you do not have appropriate access privileges"**
The script's executable bit is missing. With plugin v0.3.1+ the skill chmod +x's the script before showing it, so this shouldn't happen. If it does: `chmod +x <path>` once, then double-click. Sign of an out-of-date plugin install.

**`cdn: command not found` when the .command script runs**
The local CLI isn't on PATH for non-interactive shells. The script starts with `export PATH="$HOME/.npm-global/bin:$PATH"` — verify `npm prefix -g` returns that path. If different, the script needs editing OR add the actual `npm prefix -g` path to your shell config (`.zshrc` / `.bashrc`).

**MCP connector doesn't show the cdn_* tools after adding**
Check Worker logs with `npx wrangler tail` from inside `~/cdn-mcp`. Most likely the `MCP_AUTH_TOKEN` in the connector URL doesn't match the secret in Cloudflare. Re-set the secret with `wrangler secret put MCP_AUTH_TOKEN`, then update the connector URL in claude.ai to match.

**Public URL returns 404 right after a fresh upload**
Wait 60s for the edge cache. Or append `?_=$(date +%s)` to the URL to cache-bust and verify the R2 object actually exists. If it 404s after a minute with cache-bust, the upload failed silently — check Worker logs and re-run the smoke test in step 1.10.

**`git status` shows `wrangler.toml` as modified**
Expected. Your edits stay local; never push them. If a future `git pull` hits a merge conflict on that file, run `git checkout --ours wrangler.toml` to keep your version.

**Where to ask for help**
For bugs in the source: GitHub issues at https://github.com/code22d/cdn-mcp/issues. For your local setup, paste the failing command + output into Claude Code (or any chat client) and ask for help.

## Security notes

- **Never commit secrets.** Your `MCP_AUTH_TOKEN`, R2 access key, and R2 secret access key live in Cloudflare (via `wrangler secret put`) and locally in `~/.cdn-cli/config.json`. **Never** in a git repo, never in a public chat, never in a shared document.
- `wrangler.toml` contains your `account_id` and `database_id` — these are identifiers, not secrets. Safe locally. Still don't push to a public remote.
- **If you suspect a token leak:** rotate fast. `openssl rand -hex 32` for a new value, `npx wrangler secret put MCP_AUTH_TOKEN` to update the Worker, edit the connector URL in claude.ai and your `~/.cdn-cli/config.json` to match. ~2 minutes end to end.
- **R2 bucket access** is controlled by the bucket's API tokens (which you created in step 1.8) — they grant Object Read & Write on your bucket. If those leak, anyone can upload/delete in your bucket. Rotate the same way: Cloudflare dashboard → R2 → Manage R2 API Tokens → revoke + recreate.
- This deployment is for personal use. If you'll allow other people to upload via the MCP, treat `MCP_AUTH_TOKEN` as a shared secret and rotate often.

# Set up your personal CDN — guided install via Claude Code

> **What this is:** Paste everything below the `---` line into a fresh Claude Code session on your computer. Claude will install dependencies, deploy your Cloudflare Worker, configure the local CLI, and walk you through the few clicks that need to happen in a web browser.
>
> **Prerequisites:**
> - **Claude Code** installed (`npm install -g @anthropic-ai/claude-code`, then run `claude` in any folder)
> - **A Cloudflare account** — free tier is fine. Sign up at https://dash.cloudflare.com/sign-up if you don't have one.
> - **A GitHub account** (for downloading public source). Sign up at https://github.com/signup if needed.
> - **Optional but recommended:** a domain you can move to Cloudflare DNS (so you get URLs like `cdn.your-domain.com` instead of `pub-xxxxx.r2.dev`). Skip this if you're happy with default Cloudflare URLs.
> - **A Mac, Linux, or Windows machine** with internet access. Most commands assume macOS; Claude will adapt for your OS.
>
> **What you'll have when done:** Your own personal CDN at `cdn.<your-domain>` (or `pub-xxxxx.r2.dev`), MCP-controllable from inside Cowork via natural-language uploads, and a local `cdn` CLI for files larger than ~1 MB.
>
> **Time:** ~30–60 minutes including waiting for DNS propagation. Claude does most of it; you'll click through a few Cloudflare dashboard screens.

---

You are a Claude Code session helping me set up my own personal CDN, cloned from the open-source project at https://github.com/code22d/cdn-mcp.

Read the full architecture at https://github.com/code22d/cdn-mcp/blob/main/PARTNER-SETUP.md if you need orientation. The short version: I'll be standing up a Cloudflare Worker (the MCP brain) that controls an R2 bucket (file bytes) and a D1 database (file metadata), all under my own Cloudflare account. There's also a local CLI for uploads that don't fit through MCP, and a Cowork plugin that gives me a `cdn-file-upload` skill in Claude.

Your job: minimize copy-paste-to-terminal for me. Run everything via your Bash tool that can be run that way. For the dashboard-only steps, give me clear instructions with exact URLs and what to click. Ask me one batch of questions upfront, then proceed without further interruption unless something breaks.

## Phase 0 — pre-flight checks

Before asking me anything, verify what's already installed:

```bash
node --version       # need v20+
git --version
npm --version
gh --version         # GitHub CLI — needed for release downloads
wrangler --version   # Cloudflare Workers CLI — needed for deploy
```

Capture which are present and which need installing. Don't install anything yet — just report what you see.

## Phase 1 — info-gathering (ask me once, batch)

Ask me these questions in a single message (use a multi-question prompt if your environment supports it):

1. **OS:** macOS, Linux, or Windows? (You probably already know this from `uname` — confirm anyway.)
2. **Cloudflare account ID:** find at https://dash.cloudflare.com → click any zone → right sidebar. (If I don't have a zone yet, this comes from URL when logged in.)
3. **Do I have a domain on Cloudflare DNS?** If yes, what is it? If no, we'll use default workers.dev URLs (skip the custom-domain steps later).
4. **If using a custom domain — zone ID:** Cloudflare dashboard → my domain → Overview → right sidebar.
5. **Subdomain choices (defaults shown):**
    - CDN assets URL prefix: `cdn.<my-domain>` (default) — where my files will be publicly readable
    - MCP API host: `cdn-mcp.<my-domain>` (default) — where the Worker lives
6. **R2 bucket name:** `cdn-assets` (default) — anything alphanumeric + hyphens
7. **D1 database name:** `cdn-db` (default)
8. **Worker name:** `cdn-mcp` (default)
9. **Where should I clone the source?** Default: `~/cdn-mcp`

After I answer, summarize what you'll do back to me in 5–10 lines and ask me to confirm before proceeding.

## Phase 2 — install missing prerequisites (Bash)

For each tool missing from Phase 0:

- **Node 20+:**
    - macOS with Homebrew: `brew install node@20 && brew link --overwrite node@20`
    - Linux: use the partner's package manager (`apt install nodejs npm` on Debian/Ubuntu)
    - Windows: ask me to install from https://nodejs.org (LTS) — Claude Code can't run installers
- **Git:** usually already installed; if not, `brew install git` / `apt install git`
- **GitHub CLI (`gh`):** `brew install gh` / `apt install gh` / `winget install GitHub.cli`
- **Wrangler:** `npm install -g wrangler`

After installs, confirm each tool runs with `--version` again. If any failed (e.g., npm global install needs sudo), STOP and tell me what to do — don't sudo on my behalf.

## Phase 3 — authenticate to GitHub and Cloudflare

Run these in sequence and tell me what to expect:

```bash
gh auth login         # prompts for browser flow; use HTTPS + login via web browser
wrangler login        # opens browser to authorize Cloudflare
```

After each, verify:

```bash
gh auth status
wrangler whoami       # should show my Cloudflare email
```

If either fails, stop and ask me what happened.

## Phase 4 — clone source and install dependencies

```bash
git clone https://github.com/code22d/cdn-mcp.git ~/cdn-mcp
cd ~/cdn-mcp
npm install
```

Then verify the typecheck passes:

```bash
npx tsc --noEmit
npm test
```

If tests fail, stop and report which ones. Don't proceed with a broken build.

## Phase 5 — configure wrangler.toml programmatically

Open `~/cdn-mcp/wrangler.toml` and edit in place (use `sed`, a Python one-liner, or just read+write the file via your file tools — whatever's cleanest in your environment):

- `account_id` → my Cloudflare account ID from Phase 1
- `[vars] PUBLIC_URL_PREFIX` → `"https://cdn.<my-domain>"` if custom domain, or skip for now and set to a placeholder I'll update after step 7
- `[[d1_databases]] database_id` → leave the placeholder; we'll fill this in Phase 6 after `wrangler d1 create` returns it
- `[[r2_buckets]] bucket_name` → my chosen name (or default `cdn-assets`)
- `route` block — keep commented out for now (we uncomment in Phase 8 if using custom domain)

Show me the diff of the changes and ask me to confirm before writing.

## Phase 6 — create R2 bucket and D1 database (Bash)

```bash
cd ~/cdn-mcp

# R2 bucket
npx wrangler r2 bucket create <my-bucket-name>

# D1 database — capture the database_id from output
npx wrangler d1 create <my-db-name>
```

Parse the `database_id` from the wrangler output (it's a UUID printed in the success message), then update `wrangler.toml` with it programmatically. Show me the updated `[[d1_databases]]` block to confirm.

Apply the schema migration:

```bash
npx wrangler d1 migrations apply <my-db-name> --remote
```

Confirm both succeed before continuing.

## Phase 7 — generate MCP_AUTH_TOKEN and set it as a Worker secret

```bash
TOKEN=$(openssl rand -hex 32)
echo "$TOKEN" | npx wrangler secret put MCP_AUTH_TOKEN
```

Show me the generated token in the chat (NOT save it to a file — copy it for me to record somewhere safe). I'll need it for the Cowork connector URL in Phase 12 and for the CLI config in Phase 11.

Verify:

```bash
npx wrangler secret list
# Expected: MCP_AUTH_TOKEN
```

## Phase 8 — (optional, custom domain only) bind R2 and Worker to my domain

**If I'm using the default workers.dev URL, skip this entire phase.** Otherwise:

### 8.A R2 custom domain (asset URLs)

This is a Cloudflare dashboard step — open a browser tab:

1. https://dash.cloudflare.com → R2 → my-bucket → Settings → Custom Domains → **Connect Domain**
2. Enter subdomain (e.g., `cdn.my-domain.com`)
3. Cloudflare auto-creates the CNAME on my zone
4. Wait ~2 minutes for SSL cert provisioning. Tell me when it's ready (you can poll the URL with `curl -I https://cdn.<my-domain>` — should return 200 or a Cloudflare 404 once cert is live).

After this is live, update `wrangler.toml`'s `PUBLIC_URL_PREFIX` to `"https://cdn.<my-domain>"` if it wasn't already set.

### 8.B Worker custom route (MCP API URL)

Edit `wrangler.toml` and uncomment the `route` block. Set:
- `pattern` → `"cdn-mcp.<my-domain>/*"`
- `zone_id` → my zone ID from Phase 1

Then I add a DNS record manually:

1. https://dash.cloudflare.com → my domain → DNS → Records → **Add record**
2. Type: A
3. Name: `cdn-mcp`
4. IPv4: `192.0.2.1` (TEST-NET-1 — never reached; Cloudflare edge intercepts via the Worker route)
5. Proxy status: **Proxied** (orange cloud)

Walk me through this and confirm when done.

## Phase 9 — (optional, only if I'll upload files >100 MB) Phase 4 prerequisites

Skip if I'm only ever uploading small files. Otherwise:

This is also a dashboard step:

1. https://dash.cloudflare.com → R2 → **Manage R2 API Tokens** → **Create API Token**
2. Permissions: Object Read & Write
3. Specify bucket: my bucket name
4. Copy the Access Key ID and Secret Access Key (shown only once — capture both immediately)

Once I paste them back to you:

```bash
echo "<access-key-id>" | npx wrangler secret put R2_ACCESS_KEY_ID
echo "<secret-access-key>" | npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Then enable CORS on the bucket (also dashboard):
1. R2 → my bucket → Settings → CORS Policy → **Add CORS policy**
2. Paste:
    ```json
    [{"AllowedOrigins": ["*"], "AllowedMethods": ["PUT", "GET", "HEAD"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600}]
    ```

## Phase 10 — deploy the Worker

```bash
cd ~/cdn-mcp
npx wrangler secret list  # confirm MCP_AUTH_TOKEN present (and R2 keys if Phase 9 ran)
npm run deploy
```

After deploy succeeds, capture the deployed URL from wrangler output. It'll be either:
- `https://cdn-mcp.<my-domain>` (if Phase 8.B custom route is live)
- `https://cdn-mcp.<account-subdomain>.workers.dev` (default)

Smoke test:

```bash
HOST="<deployed-host>"   # set from above
TOKEN="<MCP_AUTH_TOKEN from Phase 7>"

# Health check
curl -s "https://$HOST/health"
# Expect: {"status":"ok","service":"cdn-mcp","version":"0.1.0-phase5a",...}

# MCP tools/list
curl -s -X POST "https://$HOST/mcp/$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '.result.tools | length'
# Expect: 13
```

If either fails, stop and tell me what came back.

## Phase 11 — install and configure the local CLI

```bash
gh release download v0.1.0 --repo code22d/cdn-cli --pattern "*.tgz" --dir /tmp
npm install -g /tmp/22d-cdn-cli-0.1.0.tgz
rm /tmp/22d-cdn-cli-0.1.0.tgz

cdn version  # expect 0.1.0
```

Create `~/.cdn-cli/config.json` programmatically with my values (don't ask me to copy-paste a JSON template):

```json
{
  "mcp": {
    "url": "https://<my-host>/mcp/<my-token>"
  },
  "r2": {
    "accountId": "<my-account-id>",
    "accessKeyId": "<my-r2-access-key>",
    "secretAccessKey": "<my-r2-secret>",
    "bucket": "<my-bucket-name>"
  },
  "publicUrlPrefix": "https://cdn.<my-domain>"
}
```

If I skipped Phase 9 (no R2 API keys yet), set those to empty strings and tell me the CLI's upload commands won't work until I add them.

Then verify:

```bash
cdn projects   # should return a list (initially empty)
```

## Phase 12 — download the Cowork plugin

```bash
gh release download plugin-v0.3.1 --repo code22d/cdn-mcp --pattern "*.plugin" --dir ~/Downloads
```

Tell me the full path of the downloaded `.plugin` file. I'll install it in Cowork in Phase 14.

## Phase 13 — add my Worker as a Cowork connector

This is a claude.ai dashboard step — open a browser tab to https://claude.ai → Settings → Customize → Connectors → **Add custom connector**:

- URL: `https://<my-host>/mcp/<my-token>` (paste the exact URL from Phase 7 + Phase 10)
- Name: `cdn-mcp` (or anything — the name is just a label)

Tell me what to click. After it's added, ask me to confirm the connector page shows it as connected (a green dot or status indicator).

## Phase 14 — install the Cowork plugin

Open a Cowork session in https://claude.ai/cowork (or the Cowork desktop app). In that session:

1. Tell Claude: *"Install this plugin: `~/Downloads/cdn-mcp-plugin.plugin`"*
2. Cowork will call `present_files` and show the .plugin as a card
3. Click **Save plugin** on the card → plugin installed
4. Open a fresh Cowork session
5. Type `/cdn-file-upload` — the skill should appear in the menu

Walk me through this.

## Phase 15 — final smoke test (end-to-end)

In the same fresh Cowork session, ask Claude:

> *"Upload `/tmp/hello.txt` to project test on the CDN"*

First, in your Claude Code session (this one), create the test file:

```bash
echo "hello from my new CDN" > /tmp/hello.txt
```

Then I'll do the Cowork upload. Watch the Cowork chat — the skill should:

1. Notice the file is < 1 MB → use Path A (MCP base64 round-trip)
2. Upload via `cdn_upload_file`
3. Confirm with the public URL

Verify the public URL serves the bytes:

```bash
curl https://cdn.<my-domain>/test/hello.txt
# Expect: "hello from my new CDN"
```

If using workers.dev URL: `curl https://pub-<r2-hash>.r2.dev/test/hello.txt`.

## Phase 16 — done

Report success in 5 lines:

- Deployed Worker URL
- Public CDN URL prefix
- One sample uploaded file URL
- CLI is configured at `~/.cdn-cli/config.json`
- Plugin is installed in Cowork

Suggest next steps:

- Read https://github.com/code22d/cdn-mcp/blob/main/README.md for daily-use commands
- Run `cdn help` for CLI commands
- Try a large upload in Cowork (file > 1 MB) to verify Path E (clickable script) fires
- Check the Cloudflare dashboard → R2 / D1 / Workers to see usage

## If anything goes wrong

- **Wrangler errors:** `wrangler tail` shows live Worker logs
- **`gh auth login` flow stuck:** re-run with `--web` flag, or do `gh auth status` to see what's already configured
- **`npm install -g wrangler` fails with EACCES:** never use `sudo npm`. Either fix npm prefix with `npm config set prefix '~/.npm-global'` and add `~/.npm-global/bin` to PATH, or use `nvm` to manage Node.
- **MCP curl returns 401:** the token in the URL doesn't match the secret. Re-set the secret with the same token value, or generate a fresh one and update both places.
- **Public URL returns 404 immediately after upload:** wait 60s for edge cache, or append `?_=<random>` to the URL to bypass cache.
- **Cowork doesn't see the cdn_* tools:** in claude.ai → Settings → Connectors, click the connector and "refresh tools." If still missing, the MCP_AUTH_TOKEN in the URL doesn't match the Worker's secret.

For anything else, paste the error back here and I'll help debug.

## Security notes

- Your `MCP_AUTH_TOKEN`, R2 access key, and R2 secret access key are credentials. They live in Cloudflare (set via `wrangler secret put`) and locally in `~/.cdn-cli/config.json`. **Never commit them to git, paste them in public chats, or share them.**
- `wrangler.toml` contains your `account_id` and `database_id` — these are identifiers, not secrets. Safe to keep locally; just don't push your edits to any public remote.
- If you ever suspect a token leak: `openssl rand -hex 32` to generate a new one, `npx wrangler secret put MCP_AUTH_TOKEN`, update your connector URL in claude.ai, update `~/.cdn-cli/config.json`. ~2 minutes.

You have full Bash, file-edit, and web access. Start with Phase 0.

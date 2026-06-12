---
name: cdn-setup
description: Stand up a personal CDN clone (Cloudflare Worker + R2 + D1 + MCP, modeled on cdn.22d.app) — full guided setup across six phases (A–F). Triggers on "set me up with a CDN", "deploy my own CDN", "install cdn-mcp", "walk me through cdn-mcp setup", "I want my own personal CDN", or similar fresh-install requests. Cloudflare and claude.ai dashboard steps are manual click-and-paste with direct URLs and gotcha pre-warnings — no browser automation (Cloudflare blocks it). Primary mechanism: clickable .command scripts the partner double-clicks on the host to install prereqs, deploy the Worker (generates OAuth Client ID + Secret alongside the MCP token), and install the cdn-cli. Ends by adding the claude.ai Custom Connector with those OAuth credentials (13 cdn_* tools) and installing cdn-mcp-plugin v0.4.0. Do NOT fire for upload requests — that is cdn-file-upload. Only for FRESH personal-CDN setup; re-runs and partial repairs are out of scope.
---

# cdn-setup

End-to-end guided install of a personal CDN clone — Cloudflare Worker + R2 + D1 + MCP, plus a local `cdn` CLI and the `cdn-mcp-plugin` for Cowork. Six phases (A–F), each with a clear pass/fail signal. Dashboard steps (Cloudflare and claude.ai) are manual click-and-paste with direct URLs and explicit pre-warnings about the gotchas; install/deploy steps run as clickable `.command` scripts the partner double-clicks on their host. The skill never installs anything in Cowork's sandbox — it generates, the partner runs.

The sibling skill `cdn-file-upload` (shipped by the `cdn-mcp-plugin` installed in Phase F) handles uploads after this skill finishes. Use the architecture diagram in `cdn-file-upload/SKILL.md` if you need orientation on how the pieces fit together — this skill does not duplicate it.

## What's new in v0.2.0

- **Custom Connector at claude.ai now works** thanks to Phase 11 (Worker OAuth 2.1 + Streamable HTTP) and Phase 11.1 (confidential OAuth client). Partners now get the full 13 cdn_* tools in their Cowork tool picker.
- **No more Chrome MCP attempts on Cloudflare** — those pages block automation. Skill is fully manual for Cloudflare dashboard steps with direct URLs and pre-warnings about gotchas (R2 subscription $0 gate, R2-specific API tokens page, Account API tokens vs User, IP filtering left blank).
- **Plugin downloads to your Cowork-mounted folder** instead of ~/Downloads, fixing the present_files reachability issue.
- **Explicit fresh-session boilerplate** after plugin install — new skills don't hot-reload.
- **References plugin-v0.4.0** (Path E always, filename sanitization).
- **Optional `99-wrangler-tail.command` debug script** for live Worker log streaming if anything seems off.

## When to use this skill

**Trigger on**: fresh-install requests for a personal CDN clone. The description carries the canonical phrase list; common forms include *"set me up with a CDN"*, *"deploy my own CDN"*, *"install cdn-mcp"*, *"walk me through the cdn-mcp setup"*, *"I want my own personal CDN"*.

**Do NOT trigger on**:
- Upload requests (*"upload this to the CDN"*, *"put this file on cdn.22d.app"*) → `cdn-file-upload` skill.
- Re-runs or partial repairs (*"my deploy broke"*, *"the CLI says X"*) → v1 is fresh-install only; debug as a regular conversation, don't re-enter the phase flow.
- Adding a second project to an already-deployed CDN → `cdn-file-upload` or the MCP tools directly.

## What the partner ends up with

- **Worker URL** — either `https://cdn-mcp.<their-domain>` (custom) or `https://cdn-mcp.<account-subdomain>.workers.dev` (default).
- **Public CDN URL prefix** — either `https://cdn.<their-domain>` or `https://pub-<hash>.r2.dev`.
- **OAuth credentials** — an `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` pair, set as Worker secrets during deploy and saved in the partner's password manager, used to add the claude.ai Custom Connector.
- **Local `cdn` CLI** installed globally on the host, with `~/.cdn-cli/config.json` written (chmod 600).
- **Cowork Custom Connector** wired to `<Worker URL>/mcp` with the OAuth credentials, exposing 13 `cdn_*` MCP tools in fresh sessions.
- **`cdn-mcp-plugin` v0.4.0 installed** in Cowork, which ships the `cdn-file-upload` skill for natural-language uploads (clickable-script Path E for every upload, plus filename sanitization).

## Constraints + the "complete in one session" recommendation

- **Cloudflare requires a credit card on file** even for the free tier. Personal use stays at $0; the card is for usage spikes. Warn the partner loudly before the R2 subscription click — first-time partners assume "free tier" means "no card." Reason: this is the single most common drop-off point during dashboard onboarding.
- **No browser automation on Cloudflare dashboards.** The dashboard actively blocks automation-controlled browsers; attempts stall or get challenged. Every Cloudflare step is manual: the skill sends the partner a direct URL (with their `<account-id>` interpolated), tells them exactly what they'll see and which pitfalls to avoid, and asks for a paste-back. Same policy for claude.ai connector setup in Phase E — manual instructions only.
- **DNS propagation is 1–24 hours** if the partner is bringing a new domain to Cloudflare. The skill offers a workers.dev fallback so they can finish today and rebind to a custom domain later.
- **macOS is the primary tested target.** Linux scripts emit in the same shape and usually work (substitute `apt`/`dnf` for `brew`). Windows partners get an inline markdown instruction block for prereqs and a `.bat` for the CLI install + config write — not a full clickable flow. Tell Windows partners this up front.
- **The R2 API token's secret is shown ONCE** during creation (Phase A.4). If the partner misses it, they have to delete and recreate the token. Set expectations before the click.
- **Sandbox vs host.** Cowork's sandbox runs the skill, parses output, and writes scripts. It cannot install anything on the partner's host, cannot reach external HTTPS (no `gh release download` from inside the sandbox), and cannot read files from the host filesystem. Every install or wrangler command runs inside a clickable script on the partner's machine.

**Recommended: complete setup in one Cowork session.** If the partner pauses and returns later, the skill asks where they left off and may request a host-side verification command (`curl`, `cdn version`) pasted back to confirm state. Resume is best-effort — no persistent state file. If the partner gets stuck mid-flow, the chat history in the project is the only memory.

## Versions pinned in this skill

```
CDN_CLI_VERSION   = v0.1.0
CDN_CLI_TGZ_NAME  = 22d-cdn-cli-0.1.0.tgz
PLUGIN_VERSION    = plugin-v0.4.0
PLUGIN_FILE_NAME  = cdn-mcp-plugin.plugin
```

These are bumped in lockstep when new releases ship. Do not use `--latest` or `gh release list` to discover the newest — version drift across A/D/F would break resume detection and the structured pasteback.

## How this skill is structured

Six phases, each with a single clear deliverable:

| Phase | Deliverable | Surface |
|---|---|---|
| **A** | Account ID, R2 subscription, domain decision, optional R2 keys, mounted-folder path | Manual (direct URLs + paste-back) |
| **B** | Node, git, gh, wrangler installed + authed | Clickable `.command` |
| **C** | Worker + R2 bucket + D1 deployed; MCP token + OAuth Client ID/Secret set | Clickable `.command` + structured pasteback |
| **C.5/C.6** | Custom domain bound (optional) | Manual + clickable `.command` |
| **D** | CLI installed, config written, plugin downloaded to mounted folder | Clickable `.command` |
| **E** | claude.ai Custom Connector added with OAuth credentials | Manual (claude.ai) |
| **F** | Plugin installed in Cowork + smoke test in fresh session | `present_files` + hand-off |

State flows in chat across phases. After each phase, restate to the partner what's been captured and ask them to confirm before generating the next script.

## Manual dashboard pattern (replaces Chrome MCP)

This applies to every dashboard step: Phase A.1–A.4, Phase C.5, Phase C.6, Phase E.

**Do NOT attempt Chrome MCP or any browser automation against Cloudflare or claude.ai.** Cloudflare's dashboard detects and blocks automation-controlled browsers (the v0.1.0 postmortem burned real partner time on this). Manual is not the fallback — it is the only path.

Each manual step follows the same shape:

1. **Send the exact URL**, with the partner's `<account-id>` (or zone, or bucket name) already interpolated — no "navigate to Settings → …" breadcrumb trails when a deep link exists.
2. **Pre-warn about what they'll see**, especially anything that looks scary or has a wrong-looking default (credit-card screens showing $0.00, two similarly-named buttons, fields that must stay blank).
3. **Say exactly what to copy back into chat**, and end with *"paste back when done"* or *"reply with the value when you have it."*

## Sandbox capability pre-flight

Before Phase A, confirm:

1. **`mcp__cowork__present_files` is available.** Without it the skill cannot ship clickable scripts. If missing: stop and tell the partner *"this skill needs Cowork's `present_files` tool, which I don't see in this session. Open a Cowork-supported chat and re-run."*
2. **Bash works in sandbox** (basic `echo`, `mkdir`, write to a path). Smoke-test with a one-line write to the outputs folder.
3. **Sandbox egress is blocked** — do not try `curl` or `gh release download` from the sandbox at any point in this skill. All external fetches happen inside clickable scripts on the partner's host.

## Resume detection (pause/resume across sessions)

On skill entry, ask: *"Have you started cdn-mcp setup before in another Cowork session? If yes, which phases did you finish?"*

If the partner indicates partial completion, ask them to run **on their host** the probes that match the claimed state:

| Claimed state | Host-side probe | Pass = |
|---|---|---|
| Phase B done | `node --version && wrangler --version && gh --version` | Three versions returned |
| Phase C done | `curl -s https://<their-worker-url>/health` | `{"status":"ok",...}` |
| Phase D done | `cdn version` | `0.1.0` |
| Phase E done | Partner opens claude.ai → Settings → Connectors, sees `cdn-mcp` connected | Partner confirms |
| Phase F done | Partner asks Claude `/cdn-file-upload` in a fresh session, skill appears | Partner confirms |

Partner pastes back probe output. Skill skips phases that probe-confirmed; resumes at the next incomplete one. **Do not auto-skip on partner's word alone** — always require a probe paste-back. Resume is fragile; the partner's verification is the only reliable signal.

**If the partner lost their Worker URL** between sessions: recover from the CLI config — `cat ~/.cdn-cli/config.json | jq -r .mcp.url` returns the full URL with token. If Phase D never completed (no config file yet), the partner can re-derive from the Cloudflare dashboard → Workers & Pages → the `cdn-mcp` Worker → the listed URL under "Triggers."

**If the partner lost their OAuth credentials** (needed for Phase E): they live only on the Worker (as secrets, not readable back) and wherever the partner saved them after Phase C. If gone, regenerate: re-run the relevant `wrangler secret put OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` lines on the host with fresh values (the skill can generate a small re-keying script), then use the new pair in Phase E.

If the partner cannot confirm a state, restart that phase from the top. Re-running a finished phase is safe (script generation is idempotent; `wrangler` commands are idempotent for the things this skill does).

---

## Phase A — Accounts & dashboard setup (fully manual)

Goal: capture the values needed for the deploy script. State held in chat:

- `cloudflare_account_id` (always; 32-hex)
- `cloudflare_zone_id` (only if custom domain on CF DNS)
- `domain` (custom-domain string, or `null` for workers.dev)
- `r2_access_key_id`, `r2_secret_access_key` (only if Phase A.4 ran)
- `mounted_folder` (the Cowork-mounted folder path — used in Phase D for the plugin download)

### A.1 Cloudflare account ID

Tell the partner:

> 1. Open https://dash.cloudflare.com and log in (or sign up at https://dash.cloudflare.com/sign-up if you don't have an account).
> 2. On the account home, look at the **right sidebar** — under the "API" section you'll see **Account ID**.
> 3. Copy it and paste it back here.

Store `account_id` in session memory. **Pass/fail**: 32-character hex string captured.

### A.2 R2 subscription

Direct the partner to https://dash.cloudflare.com/?to=/:account/r2 — and send this warning BEFORE they click:

> Heads up: the R2 page may show a "Purchase R2 Plan" or "Get Started" screen demanding a credit card.
> The free tier covers 10 GB storage + 1M Class A ops + 10M Class B ops per month — well above personal use.
> The "Total Due Now" will show $0.00. Click Subscribe; no charge will happen unless you exceed the free tier.

Ask the partner to reply *"R2 subscribed"* when the page shows the bucket-creation UI.

**Pass/fail**: R2 dashboard shows bucket-creation enabled.

### A.3 Custom domain decision

Ask via `AskUserQuestion` (or equivalent):

> **Domain setup**: do you want clean URLs like `cdn.your-domain.com`, or are workers.dev defaults fine?
>
> - **Already on Cloudflare DNS** — domain is on Cloudflare nameservers; I'll capture the zone ID.
> - **Have a domain, not on Cloudflare yet** — I'll walk you through adding it; takes 1–24h for nameservers to propagate.
> - **Workers.dev defaults** — skip the custom domain entirely; you'll get `pub-xxx.r2.dev` URLs. You can bind a domain later.

**If "already on Cloudflare DNS"**: tell partner *open https://dash.cloudflare.com → click your domain → the Overview page's right sidebar shows the Zone ID → copy and paste it back.*

**If "have a domain, not yet on Cloudflare"**: numbered manual steps through *Add a site* → enter domain → free plan → review DNS records → save → switch nameservers at the registrar. **Warn loudly**: *"Nameserver propagation can take up to 24 hours. I recommend finishing today on workers.dev URLs — you can rebind to your custom domain in a separate session once propagation completes. Continuing with workers.dev for now."*

**If "workers.dev defaults"**: capture `domain = null`. Skip C.5/C.6.

**Pass/fail**: either zone ID captured, or explicit workers.dev choice noted in chat.

### A.4 (Optional) R2 API token for files >100 MB

Ask via `AskUserQuestion`:

> **Will you ever upload files larger than ~100 MB?** (Videos, large datasets, big design files.) If yes, I'll capture R2 API keys now — they enable the CLI's large-file upload path. If no, you can add them later.

**If yes**: send the direct URL `https://dash.cloudflare.com/<account-id>/r2/api-tokens` (interpolate the captured account ID) along with this pre-warning:

> On that page, two pitfalls to avoid:
> 1. TWO buttons: "Create Account API token" (blue, top) and "User API token" (bottom).
>    PICK "Account API token" — it's tied to the org and won't die if your user account changes.
> 2. The token form has a "Client IP Address Filtering" section with Include + Exclude fields.
>    LEAVE BOTH BLANK. The Worker calls R2 from rotating Cloudflare edge IPs, and your CLI calls
>    from changing client IPs. Any filter will lock everything out.
>
> Permissions: pick "Object Read & Write". Specify bucket: your bucket name.
> Token form shows Access Key ID + Secret Access Key after creation. Copy both NOW — they're shown only once.

Then: *"Paste the access key ID. Then paste the secret access key separately. I'll capture both and won't echo them back."*

**Capture rules** (apply for the rest of the session):
- Store `r2_access_key_id` and `r2_secret_access_key` in skill memory.
- Refer back as *"the R2 access key"* and *"the R2 secret"* — never reprint full values.
- These get baked into Phase C's deploy script (one-time-use on host) and Phase D's CLI config (chmod 600). They never appear in chat after capture.

**If no**: leave both empty. Uploads up to ~100 MB work via the Worker's signed-URL flow with just the MCP token; larger files need the R2 keys, which can be added to `~/.cdn-cli/config.json` (and as Worker secrets) later. Tell the partner this.

**Pass/fail**: keys captured, or explicit skip noted.

### A.5 Cowork-mounted folder (for the Phase D plugin download)

Phase D downloads the `.plugin` file to a folder Cowork can reach, so Phase F's `present_files` works. `~/Downloads` is NOT reachable from the sandbox — that was a v0.1.0 postmortem failure.

1. **Check the session context first.** The skill already knows the mounted folder in the typical case — it's the workspace folder path visible in the session env (the same path used for OS detection). If found, use it and show the partner: *"I see your Cowork session is mounted to `~/Documents/Claude/Projects/<their-project>/`. I'll download the plugin there in Phase D."*
2. **If not detectable** (edge case), ask the partner directly:

   > I can't detect your Cowork-mounted folder automatically. Ask Claude in this same chat: *"what folder are you mounted into?"* — Claude will respond with the path. Paste that path back to me.

Store `mounted_folder`. **Pass/fail**: an absolute host path captured (or partner explicitly defers — then Phase D falls back to `~/Downloads` + the `03b` copy script).

### Phase A wrap

Restate to the partner:

```
Phase A summary:
- Cloudflare account ID: <captured ✓>
- R2 subscription: active ✓
- Domain: <"custom: example.com" | "workers.dev (will bind later)" | "workers.dev (default)">
- Zone ID: <captured ✓ | n/a>
- R2 API keys: <captured ✓ | skipped (files ≤100 MB only)>
- Cowork-mounted folder: <path ✓ | will use ~/Downloads + copy step>
```

Ask: *"Ready to proceed to Phase B (install prerequisites on your machine)?"*

---

## Phase B — Install prerequisites (clickable script)

Goal: Node 20+, git, gh CLI, wrangler CLI installed and authed on the partner's host.

### OS detection

Inspect the workspace folder path Cowork is operating in (same logic as `cdn-file-upload/SKILL.md`):

| Path prefix | OS | Script type |
|---|---|---|
| `/Users/...` | macOS | `.command` |
| `/home/...` | Linux | `.sh` |
| `^[A-Za-z]:` or contains backslash | Windows | (markdown block, not a script) |
| Ambiguous | macOS default | `.command` + offer to regenerate |

**Windows**: do not emit a `.bat` for prerequisites — `winget`/`choco` need elevation and partner-specific tweaks. Instead, print an inline markdown block listing the four installs (Node from nodejs.org LTS, git from git-scm.com, gh from cli.github.com, wrangler via `npm install -g wrangler`) plus the `gh auth login` + `wrangler login` commands. Ask the partner to paste back `node --version && wrangler --version && gh --version && git --version` once done. Skip to Phase C when those pass.

### Script content

Generated from `scripts/01-install-prereqs.command.template`. The template contains a bash skeleton with `# {{OS_INSTALL_BLOCK}}` as a placeholder for OS-specific install commands. The skill substitutes:

**macOS** (`{{OS_INSTALL_BLOCK}}`):
```bash
if ! command -v brew >/dev/null 2>&1; then
  echo "Installing Homebrew first (you'll be prompted for your password)..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
[[ -z "$(command -v node)" || $(node -v | sed 's/v//' | cut -d. -f1) -lt 20 ]] && brew install node@20 && brew link --overwrite node@20
command -v git >/dev/null 2>&1 || brew install git
command -v gh  >/dev/null 2>&1 || brew install gh
command -v wrangler >/dev/null 2>&1 || npm install -g wrangler
```

**Linux** (`{{OS_INSTALL_BLOCK}}`):
```bash
if command -v apt >/dev/null 2>&1; then PKG="sudo apt install -y"
elif command -v dnf >/dev/null 2>&1; then PKG="sudo dnf install -y"
else echo "Unsupported package manager. Install Node 20+, git, and gh manually."; exit 1
fi
[[ -z "$(command -v node)" || $(node -v | sed 's/v//' | cut -d. -f1) -lt 20 ]] && curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && $PKG nodejs
command -v git >/dev/null 2>&1 || $PKG git
command -v gh  >/dev/null 2>&1 || $PKG gh
command -v wrangler >/dev/null 2>&1 || npm install -g wrangler
```

### Flow

1. Write script to outputs folder (e.g., `/sessions/<session>/mnt/outputs/01-install-prereqs.command`).
2. **`chmod +x` the script** before `present_files`. Cowork preserves the executable bit through Save (confirmed at `cdn-file-upload/SKILL.md`).
3. Call `mcp__cowork__present_files` with the script.
4. Tell the partner:

   > Double-click `01-install-prereqs.command` to run. The script checks what's installed and installs anything missing. It will:
   > 1. Possibly prompt for your password (Homebrew install).
   > 2. Open your browser twice — once for GitHub auth, once for Cloudflare/wrangler auth.
   > 3. Print a structured `=== PHASE B COMPLETE ===` block at the end.
   >
   > Paste the block back when done. (First time, you may need right-click → Open to bypass macOS's Gatekeeper warning.)

5. **Wait for paste-back.** Do not generate Phase C until the partner confirms.
6. Parse the block; verify all four tools returned a version.

**Pass/fail**: Phase B complete block pasted back with all four versions present.

---

## Phase C — Deploy the Worker (clickable script)

Goal: Worker deployed; R2 bucket + D1 database created and migrated; **three secrets set** (`MCP_AUTH_TOKEN`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`); deployed URL captured.

### Script content

Generated from `scripts/02-deploy-worker.command.template`. The template's `sed` substitutions target six specific line shapes in the upstream `wrangler.toml` (verified against the repo): `account_id = "..."`, `CLOUDFLARE_ACCOUNT_ID = "..."` (in `[vars]`), `bucket_name = "..."` (in `[[r2_buckets]]`), `PUBLIC_URL_PREFIX = "..."` (in `[vars]`), `database_name = "..."` and `database_id = "..."` (in `[[d1_databases]]`). It also **comments out the inline `route = { ... }` line** so the initial deploy doesn't try to bind to a domain the partner doesn't own — Phase C.6 uncomments and rewrites it for custom-domain partners. If the upstream `wrangler.toml` is ever reformatted (multi-line table-of-tables for the route, comments inserted before targeted lines), the script's regexes need to be updated to match.

Every Phase A value gets baked in via `{{PLACEHOLDER}}` substitution before write:

- `{{CLOUDFLARE_ACCOUNT_ID}}` from A.1
- `{{R2_BUCKET_NAME}}` (default `cdn-assets`, partner can override in chat)
- `{{D1_DB_NAME}}` (default `cdn-db`)
- `{{WORKER_NAME}}` (default `cdn-mcp`)
- `{{PUBLIC_URL_PREFIX_PLACEHOLDER}}` — either `"https://cdn.<domain>"` (if A.3 = custom on CF) or `"PENDING"` (workers.dev; replaced after deploy parses the URL)
- `{{R2_ACCESS_KEY_ID}}` and `{{R2_SECRET_ACCESS_KEY}}` from A.4 — or empty strings (script branches on emptiness)

The script:
1. `git clone https://github.com/code22d/cdn-mcp.git ~/cdn-mcp` (skips if `~/cdn-mcp` exists).
2. `cd ~/cdn-mcp && npm install`.
3. Patches `wrangler.toml` in place using `sed` with the substituted values.
4. `npx wrangler r2 bucket create {{R2_BUCKET_NAME}}` (idempotent — succeeds or returns "already exists").
5. `npx wrangler d1 create {{D1_DB_NAME}}` → captures the `database_id` from output → patches `wrangler.toml`.
6. `npx wrangler d1 migrations apply {{D1_DB_NAME}} --remote`.
7. **Generates and sets THREE secrets** (Phase 11.1 confidential OAuth client):

   ```bash
   MCP_AUTH_TOKEN=$(openssl rand -hex 32)
   OAUTH_CLIENT_SECRET=$(openssl rand -hex 32)
   OAUTH_CLIENT_ID="cdn-mcp-claude"

   echo "$MCP_AUTH_TOKEN" | npx wrangler secret put MCP_AUTH_TOKEN
   echo "$OAUTH_CLIENT_SECRET" | npx wrangler secret put OAUTH_CLIENT_SECRET
   echo "$OAUTH_CLIENT_ID" | npx wrangler secret put OAUTH_CLIENT_ID
   ```

   With both OAuth secrets set, the Worker requires the pre-shared Client ID + Secret on the claude.ai Custom Connector (Phase E).
8. If `{{R2_ACCESS_KEY_ID}}` is non-empty, also sets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` as secrets.
9. `npm run deploy`.
10. Parses the deployed URL from wrangler's output (look for the `https://...workers.dev` or custom-route URL line).
11. (workers.dev partners only) Attempts to derive the public R2 dev URL via `wrangler r2 bucket dev-url enable`/`get`. If the subcommand fails (syntax has shifted across wrangler versions), the script falls back to `https://pub-PENDING.r2.dev` and the partner can grab the real value manually from **Cloudflare dashboard → R2 → the bucket → Settings → Public R2.dev Bucket URL → "Allow Access" → copy the URL** — then update `~/.cdn-cli/config.json`'s `publicUrlPrefix` and re-set the Worker's `PUBLIC_URL_PREFIX` var (one redeploy) so future uploads return the right URLs.
12. Runs the inline smoke test (next section).
13. Echoes the structured pasteback block.

### Inline smoke test (runs on host before pasteback)

```bash
echo "→ Smoke test: /health"
HEALTH=$(curl -s "https://$WORKER_HOST/health")
echo "$HEALTH"
echo "$HEALTH" | grep -q '"status":"ok"' || { echo "✗ Health check failed"; exit 1; }

echo "→ Smoke test: MCP tools/list"
TOOL_COUNT=$(curl -s -X POST "https://$WORKER_HOST/mcp/$MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | grep -o '"name":"cdn_' | wc -l | tr -d ' ')
echo "Tool count: $TOOL_COUNT"
[[ "$TOOL_COUNT" == "13" ]] || { echo "✗ Expected 13 cdn_* tools, got $TOOL_COUNT"; exit 1; }
echo "✓ Smoke test passed"
```

### Structured pasteback (skill parses this)

The script ends with:

```
=== CDN-SETUP DEPLOY OUTPUT ===
WORKER_URL: https://cdn-mcp.example.workers.dev
MCP_AUTH_TOKEN: <64 hex chars>
OAUTH_CLIENT_ID: cdn-mcp-claude
OAUTH_CLIENT_SECRET: <64 hex chars>
R2_BUCKET: cdn-assets
D1_DATABASE_ID: 8400e8c0-1c5e-4f1d-9eaa-aa3b41c5e9d4
PUBLIC_URL_PREFIX: https://pub-abc123.r2.dev
=== END ===
```

Skill parses this block with a simple regex (`^([A-Z_]+): (.+)$` between the delimiters) and captures all seven values into chat state. The partner will need `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` to paste into claude.ai during Phase E.

**After parsing, tell the partner explicitly:**

> I've captured your OAuth credentials. Save them somewhere secure (password manager, encrypted notes):
> - OAUTH_CLIENT_ID: `<value>`
> - OAUTH_CLIENT_SECRET: `<value>`
>
> You'll need these to add the Cowork connector in Phase E. After this Cowork session ends,
> I won't have access to them anymore — they live on your Worker (set as secrets) and now in your notes.

> ⚠ **The MCP_AUTH_TOKEN also appears in the block once** so the partner can save it to a password manager. After capture, the skill does not echo the token back — references in later messages use `<your MCP token>` or similar.

### Flow

1. Write script to outputs folder, `chmod +x`, `present_files`.
2. Tell partner:

   > Double-click `02-deploy-worker.command`. This takes 3–5 minutes: clone, install, create R2 bucket, create D1 database, apply migrations, generate auth token + OAuth credentials, deploy Worker, smoke-test, and print a paste-back block.
   >
   > **Save the `MCP_AUTH_TOKEN`, `OAUTH_CLIENT_ID`, and `OAUTH_CLIENT_SECRET` from the paste-back block to your password manager.**
   >
   > Paste the entire `=== CDN-SETUP DEPLOY OUTPUT ===` block back when done.

3. Wait for paste-back. Parse. Deliver the OAuth-credentials save reminder above.
4. Confirm to partner: *"Got it. Worker is at `<url>`; public URLs will be served from `<prefix>`. Proceeding to Phase D."* (Or to C.5/C.6 if custom domain.)
5. **If anything seems off** after the deploy (smoke test failed, URL looks wrong), offer the `99-wrangler-tail.command` debug script (see *Debug affordance* below).

**Pass/fail**: pasteback parsed; all seven values captured; smoke test reported ✓ inside the script output.

### Phase C.5 — (custom domain only) R2 custom domain binding

Skip unless A.3 chose a custom domain.

**Manual steps**: send the partner to `https://dash.cloudflare.com/<account-id>/r2/buckets/<bucket-name>/settings` (interpolate both values). Numbered steps: scroll to *Custom Domains* → *Connect Domain* → enter the subdomain (e.g., `cdn.example.com`) → Cloudflare auto-creates the CNAME on the zone → wait ~2 minutes for SSL provisioning.

**Verify**: tell partner to run on host: `curl -I https://cdn.<their-domain>`. Expect a 200 or Cloudflare 404 (cert is live). Paste output back.

**Update state**: set `PUBLIC_URL_PREFIX = "https://cdn.<domain>"` in chat state (overrides whatever Phase C captured).

### Phase C.6 — (custom domain only) Worker route + DNS record + redeploy

Skip unless A.3 chose a custom domain.

**Add DNS A record (manual)**: dashboard → domain → DNS → Records → *Add record*. Type A, Name `cdn-mcp` (or partner's chosen subdomain), IPv4 `192.0.2.1` (TEST-NET-1; never reached; Cloudflare's edge intercepts via the Worker route), Proxy status *Proxied* (orange cloud).

**Then run the redeploy script**:

Generated from `scripts/02b-bind-route-redeploy.command.template`. Substitutes `{{ZONE_ID}}` and `{{ROUTE_PATTERN}}` (e.g., `cdn-mcp.example.com/*`). The script uncomments the `route` block in `~/cdn-mcp/wrangler.toml` with the right values, then runs `npm run deploy` again.

**Verify**: partner runs `curl -s https://cdn-mcp.<their-domain>/health` → expect `{"status":"ok",...}`. Paste back.

**Update state**: set `WORKER_URL = "https://cdn-mcp.<domain>"` (overrides Phase C value).

---

## Phase D — Install CLI + download plugin to the mounted folder (clickable script)

Goal: `cdn` CLI installed globally; `~/.cdn-cli/config.json` written with all values; `cdn-mcp-plugin.plugin` (v0.4.0) downloaded to the **Cowork-mounted folder** captured in A.5, so Phase F's `present_files` can reach it.

### Script content

Generated from `scripts/03-install-cli.command.template`. Substitutes:

- `{{CDN_CLI_VERSION}}` = `v0.1.0`
- `{{CDN_CLI_TGZ_NAME}}` = `22d-cdn-cli-0.1.0.tgz`
- `{{PLUGIN_VERSION}}` = `plugin-v0.4.0`
- `{{PLUGIN_FILE_NAME}}` = `cdn-mcp-plugin.plugin`
- `{{MOUNTED_FOLDER}}` from A.5 (absolute host path; the plugin download destination)
- `{{WORKER_URL}}` from Phase C (or C.6 if custom)
- `{{MCP_AUTH_TOKEN}}` from Phase C
- `{{CLOUDFLARE_ACCOUNT_ID}}` from A.1
- `{{R2_ACCESS_KEY_ID}}` from A.4 (or empty string)
- `{{R2_SECRET_ACCESS_KEY}}` from A.4 (or empty string)
- `{{R2_BUCKET_NAME}}` from C
- `{{PUBLIC_URL_PREFIX}}` from C (or C.5 if custom)

The script:
1. `gh release download {{CDN_CLI_VERSION}} --repo code22d/cdn-cli --pattern "*.tgz" --dir /tmp`.
2. `npm install -g /tmp/{{CDN_CLI_TGZ_NAME}} && rm /tmp/{{CDN_CLI_TGZ_NAME}}`.
3. `mkdir -p ~/.cdn-cli` and write the config JSON (heredoc, see below).
4. `chmod 600 ~/.cdn-cli/config.json`.
5. Verify: `cdn version` should print `0.1.0`; `cdn projects` should return an empty list.
6. Download the plugin **into the mounted folder**: `gh release download plugin-v0.4.0 --repo code22d/cdn-mcp --pattern "*.plugin" --dir {{MOUNTED_FOLDER}}`.
7. Echo `=== PHASE D COMPLETE ===` with the **full absolute path** of the downloaded `.plugin` file — the skill passes this path to `present_files` in Phase F.

### Config JSON structure

```json
{
  "mcp": {
    "url": "{{WORKER_URL}}/mcp/{{MCP_AUTH_TOKEN}}"
  },
  "r2": {
    "accountId": "{{CLOUDFLARE_ACCOUNT_ID}}",
    "accessKeyId": "{{R2_ACCESS_KEY_ID}}",
    "secretAccessKey": "{{R2_SECRET_ACCESS_KEY}}",
    "bucket": "{{R2_BUCKET_NAME}}"
  },
  "publicUrlPrefix": "{{PUBLIC_URL_PREFIX}}"
}
```

If A.4 was skipped, `accessKeyId` and `secretAccessKey` are empty strings — uploads >100 MB will fail until they're added, but everything else works.

### Fallback: partner skipped the mounted-folder capture

If `mounted_folder` was never captured in A.5, the script downloads to `~/Downloads` instead, and the skill generates a second clickable script from `scripts/03b-copy-plugin-to-mount.command.template` that copies `~/Downloads/cdn-mcp-plugin.plugin` into the mounted folder once the partner identifies it. Get the path before Phase F — `present_files` cannot reach `~/Downloads`.

### Windows variant

For Windows partners, emit `03-install-cli.bat` from a separate template (same substitutions; cmd-syntax heredoc; uses `mkdir %USERPROFILE%\.cdn-cli`, `echo > %USERPROFILE%\.cdn-cli\config.json`, `icacls` for the equivalent of `chmod 600`). Plugin downloaded to the mounted folder (same as Mac/Linux). Partner double-clicks the `.bat`.

### Fallback if `gh release download` fails on the partner's host

If the script's `gh release download` step errors (network issue, gh-auth expired, release renamed), tell the partner:

> Looks like `gh release download` failed. You can download both files directly in your browser:
>
> - **CLI**: https://github.com/code22d/cdn-cli/releases/download/v0.1.0/22d-cdn-cli-0.1.0.tgz → save it, then run `npm install -g <path-to-the-tgz>`
> - **Plugin**: https://github.com/code22d/cdn-mcp/releases/download/plugin-v0.4.0/cdn-mcp-plugin.plugin → save it **into your Cowork-mounted folder** (`<mounted_folder>`)
>
> Once both are in place, reply "downloaded" and I'll continue.

The skill resumes from step 3 (config write) when the partner confirms.

### Flow

1. Generate script (or `.bat` for Windows). `chmod +x` if `.command`/`.sh`.
2. `present_files`.
3. Tell partner what to expect (~30 seconds runtime; outputs a path).
4. Wait for paste-back of `=== PHASE D COMPLETE ===` block including the plugin path.
5. Capture `PLUGIN_PATH` into chat state.

**Pass/fail**: pasteback shows `cdn version` returned `0.1.0`, `cdn projects` returned `[]` or a list, and the plugin file path points inside the mounted folder.

---

## Phase E — Add the Cowork Custom Connector with OAuth credentials

Now we'll connect Cowork to your deployed Worker via a Custom Connector. This gives you the 13 cdn_* tools (cdn_help, cdn_upload_file, cdn_get_stats, etc.) in any Cowork session.

**Manual instructions only — do not attempt browser automation against claude.ai.** Walk the partner through, interpolating the captured values:

> You'll need the values I captured from Phase C:
> - Your Worker URL: `<WORKER_URL>`
> - OAUTH_CLIENT_ID: `<from Phase C>`
> - OAUTH_CLIENT_SECRET: `<from Phase C>`
>
> Steps:
>
> 1. Open https://claude.ai/customize/connectors in your browser
> 2. Click **+** at the top → **Add custom connector**
> 3. Fill in:
>    - **Name:** `cdn-mcp` (or whatever)
>    - **Remote MCP server URL:** `<WORKER_URL>/mcp`
> 4. Click **Advanced settings** to expand the OAuth fields
> 5. Paste:
>    - **OAuth Client ID:** `<OAUTH_CLIENT_ID>`
>    - **OAuth Client Secret:** `<OAUTH_CLIENT_SECRET>`
> 6. Click **Add**
> 7. The connector card should show as connected (green dot / Disconnect button visible)
> 8. Click into the card → verify all 13 cdn_* tools are listed
>
> Tell me when the connector is connected and you see the 13 tools. I'll verify and move to Phase F.

If anything fails:
- **"Server not found" / "Couldn't reach the MCP server"** → the URL is wrong or the Worker isn't responding. Run the `99-wrangler-tail.command` debug script (available on request — see *Debug affordance*) to see what claude.ai is actually sending.
- **Connector appears but tools don't show** → OAuth credentials didn't match. Re-check Client ID and Secret values against what Phase C printed.

**Pass/fail**: partner reports the connector connected and 13 `cdn_*` tools visible.

---

## Phase F — Install plugin + smoke-test hand-off

Goal: `cdn-mcp-plugin` v0.4.0 installed in Cowork; first end-to-end upload completes in a fresh session.

### Plugin install (in this session)

The plugin file is in the Cowork-mounted folder (Phase D step 6), so the skill **calls `mcp__cowork__present_files` with the explicit `PLUGIN_PATH`** captured from the Phase D pasteback. Then tell the partner:

> The plugin file is now in your Cowork-mounted folder. I'll surface it as a card —
> click "Save plugin" on the card to install.
>
> IMPORTANT: After saving, close this Cowork session and open a fresh one. The new
> plugin's skill (cdn-file-upload) won't appear until the next session loads.

Explicit boilerplate, every time. **Do not ask the partner to retry in the same session** — installed skills do not hot-reload; only a fresh session picks them up.

### Smoke test (fresh Cowork session, NOT this one)

Tell the partner:

> Once the plugin shows as installed, **open a fresh Cowork session** (so the new skill loads). In the fresh session:
>
> 1. On your host, create a test file: `echo "hello from my new CDN" > /tmp/hello.txt`
> 2. In Cowork, say: *"Upload `/tmp/hello.txt` to project test on the CDN"*
> 3. The `cdn-file-upload` skill (v0.4.0 — every upload goes through a clickable script) will generate an upload script and surface it as a card.
> 4. Double-click the script. It runs `cdn upload`, then self-verifies the public URL via a curl HEAD check and prints ✓.
> 5. Report back "done" in that session — Claude will confirm via `cdn_get_stats`.
>
> Come back here and report the URL when done — I'll print the success summary.

Wait for the partner to report the URL.

### Success summary

Once smoke test passes, print:

```
✅ Personal CDN live.

  Worker:           {{WORKER_URL}}
  Public URL base:  {{PUBLIC_URL_PREFIX}}
  Connector:        claude.ai Custom Connector (OAuth) — 13 cdn_* tools
  First upload:     <url-the-partner-reported>
  CLI configured:   ~/.cdn-cli/config.json (chmod 600)
  Plugin installed: cdn-mcp-plugin v0.4.0

Next steps:
  - Run `cdn help` for CLI commands
  - Read https://github.com/code22d/cdn-mcp/blob/main/README.md for daily-use
  - Ask Cowork to upload something real — every upload is a double-click script now
  - Cloudflare dashboard → R2/D1/Workers to watch usage

If you stop seeing the cdn_* tools later: claude.ai → Settings → Connectors → cdn-mcp → "Refresh tools."
```

**Pass/fail (overall skill)**: partner reports a working public URL.

---

## Debug affordance — `99-wrangler-tail.command` (on request only)

Generated from `scripts/99-wrangler-tail.command.template` (no substitutions needed). The script runs `cd ~/cdn-mcp && npx wrangler tail` to live-stream the deployed Worker's logs in the partner's terminal.

Offer it — **never auto-generate or auto-run it** — when:
- The Phase C smoke test fails and the cause isn't obvious from the script output.
- Phase E reports "Server not found" or OAuth errors and the partner needs to see what claude.ai is sending.
- Anything else "seems off" post-deploy and a live request trace would answer it.

Flow: write the script, `chmod +x`, `present_files`, tell the partner to double-click it, keep the Terminal window visible, and reproduce the failing action (e.g., re-add the connector). The tail output shows each incoming request and the auth failure reason. Partner pastes relevant lines back; Ctrl-C closes the tail.

## Credentials handling rules

Five secrets are touched during setup:

| Secret | Source | Lives at | Re-show? |
|---|---|---|---|
| `MCP_AUTH_TOKEN` | Generated in Phase C deploy script | Cloudflare (Worker secret) + `~/.cdn-cli/config.json` | Once in Phase C pasteback; never after |
| `OAUTH_CLIENT_ID` | Generated in Phase C deploy script (`cdn-mcp-claude`) | Cloudflare (Worker secret) + partner's notes | Echoed once in the post-parse save reminder, and again verbatim in Phase E's connector instructions (it's an identifier, not a bearer secret) |
| `OAUTH_CLIENT_SECRET` | Generated in Phase C deploy script | Cloudflare (Worker secret) + partner's notes | Once in the post-parse save reminder + once in Phase E's connector instructions; never after |
| `R2_ACCESS_KEY_ID` | Phase A.4 R2 token creation | Cloudflare (Worker secret if A.4 ran) + `~/.cdn-cli/config.json` | Captured once; referred to as "your R2 access key" thereafter |
| `R2_SECRET_ACCESS_KEY` | Phase A.4 (UI shows once) | Same as above | Never echoed back to chat after capture |

**Rules**:
- After the allowed echoes above, refer back as *"your MCP token"*, *"your OAuth credentials"*, *"your R2 access key"*, *"your R2 secret"*. Do not reprint full values.
- Bake into the deploy script (Phase C) and CLI config script (Phase D) at generation time. These scripts are one-time-use on the partner's host.
- Do not write standalone credential files into the outputs folder — only the install/deploy scripts that embed them at execution time and exit.
- The Phase D CLI config script `chmod 600`s `~/.cdn-cli/config.json` so other users on the same machine cannot read it.

If a secret leaks: rotate fast. `openssl rand -hex 32` for a new value; `npx wrangler secret put MCP_AUTH_TOKEN` (or `OAUTH_CLIENT_SECRET`); update `~/.cdn-cli/config.json` and/or re-add the claude.ai connector with the new credentials. For R2 keys, delete and recreate in the dashboard. Total time ~2 minutes.

## Sandbox vs host — what runs where

| Activity | Sandbox (Cowork) | Host (partner's machine) |
|---|---|---|
| Script generation, pasteback parsing, state tracking | ✓ | — |
| `present_files` (surface scripts and plugin) | ✓ | — |
| `chmod +x` on emitted scripts | ✓ | — |
| Dashboard clicks (Cloudflare, claude.ai) | ✗ manual, partner's browser | ✓ |
| External HTTPS (`curl`, `gh release download`) | ✗ blocked | ✓ |
| `git clone`, `npm install`, `wrangler` commands | ✗ blocked | ✓ |
| `wrangler login`, `gh auth login` (browser auth) | ✗ blocked | ✓ |
| Reading partner's `~/.cdn-cli/config.json` | ✗ no host access | ✓ |

Rule: anything that needs network, install permissions, or the partner's filesystem runs inside a clickable script the partner executes (or in the partner's own browser, for dashboards). The skill never tries to bypass this.

## OS support matrix

| OS | Phase B prereqs | Phase C deploy | Phase D CLI install | Notes |
|---|---|---|---|---|
| **macOS** | `.command` (full) | `.command` (full) | `.command` (full) | Primary tested target |
| **Linux** | `.sh` (`apt`/`dnf`) | `.sh` (same as Mac) | `.sh` (same as Mac) | Tested less; usually works |
| **Windows** | Markdown chat block | Markdown chat block (or hand-translate) | `.bat` | Heaviest manual work; warn partner up front |

Tell Windows partners during Phase A wrap: *"Windows partners get an inline instruction block for Phase B + most of Phase C — only Phase D has a clickable. Heavier hands-on than Mac/Linux. Continue, or move to a Mac if you have one?"*

## What this skill does NOT do

- **Do not attempt browser automation** against Cloudflare or claude.ai — those dashboards block automation-controlled browsers. Manual direct-URL instructions are the only path.
- **Do not ship pre-baked scripts** in the .skill package. Every script is generated per partner with their values substituted at runtime. Pre-baked scripts would leak inappropriate defaults and prevent Phase A→C value flow.
- **Do not auto-install the plugin.** Cowork plugin installs go through `present_files` + the partner's Save click. That's the only supported flow.
- **Do not make Phase F's smoke test happen in the current session.** Plugins/skills load on session start; it must be a fresh Cowork session to see the new skill. Say the fresh-session boilerplate explicitly — don't let the partner retry in-session and conclude the install failed.
- **Do not auto-execute the `99-wrangler-tail.command` debug script.** Offer it when something seems off; the partner runs it.
- **Do not skip account setup** for partners who already have a Cloudflare account but no cdn-mcp deploy. This skill = fresh install only. Re-runs are out of scope; debug as a regular conversation.
- **Do not `curl` from sandbox** to verify the deployed Worker. Sandbox egress is blocked. The inline smoke test in Phase C runs on host; the partner pastes the result back.
- **Do not log secrets to chat** beyond the explicitly allowed echoes (Phase C pasteback + OAuth save reminder + Phase E connector instructions). Never reprint `MCP_AUTH_TOKEN` or R2 keys.
- **Do not modify the partner's repo or host files** outside the deploy/install scripts the partner explicitly runs.
- **Do not try to detect installed prerequisites** (`which node`, `which cdn`) from inside the sandbox — host binaries are not visible. The clickable script does the detection on host.

## References

- `skills/cdn-file-upload/SKILL.md` — companion skill that takes over after Phase F for uploads (v0.4.0: clickable-script Path E for every upload + filename sanitization). Source of OS-detection logic, executable-bit handling, and sandbox-egress constraints used here.
- `README.md` (this repo) — daily-use commands and tool reference for after setup.
- `cdn_help` MCP tool — once the connector is live, this tool returns architecture orientation inline.
- Andrew Lane's 5/22/26 install postmortem (https://designhacker.notion.site/Personal-CDN-Install-Debug-Postmortem-5-22-26-3698ee976d0c8156b77ce2d93c3bbf5e) — the issue list that drove this v0.2.0 rewrite.

---
name: cdn-setup
description: Stand up a personal CDN clone (Cloudflare Worker + R2 + D1 + MCP, modeled on cdn.22d.app) — full guided setup. Triggers on "set me up with a CDN", "deploy my own CDN", "install cdn-mcp", "walk me through cdn-mcp setup", "I want my own personal CDN", or similar fresh-install requests. Drives Chrome through Cloudflare and claude.ai dashboards when available; falls back to manual click-and-paste when not. Generates clickable .command/.bat scripts the partner double-clicks on the host to install Node/gh/wrangler, deploy the Worker, and install the cdn-cli (sandbox cannot install on host). State lives in chat across phases; partner can pause and resume. Ends by installing the cdn-mcp-plugin so the next session does uploads via cdn-file-upload. Do NOT fire for upload requests — that is cdn-file-upload. Only for FRESH personal-CDN setup; re-runs and partial repairs are out of scope for v1.
---

# cdn-setup

End-to-end guided install of a personal CDN clone — Cloudflare Worker + R2 + D1 + MCP, plus a local `cdn` CLI and the `cdn-mcp-plugin` for Cowork. Six phases (A–F), each with a clear pass/fail signal. Dashboard steps are driven through Chrome MCP when available and fall back cleanly to manual click-and-paste; install/deploy steps run as clickable `.command` scripts the partner double-clicks on their host. The skill never installs anything in Cowork's sandbox — it generates, the partner runs.

The sibling skill `cdn-file-upload` (shipped by the `cdn-mcp-plugin` installed in Phase F) handles uploads after this skill finishes. Use the architecture diagram in `cdn-file-upload/SKILL.md` if you need orientation on how the pieces fit together — this skill does not duplicate it.

## When to use this skill

**Trigger on**: fresh-install requests for a personal CDN clone. The description carries the canonical phrase list; common forms include *"set me up with a CDN"*, *"deploy my own CDN"*, *"install cdn-mcp"*, *"walk me through the cdn-mcp setup"*, *"I want my own personal CDN"*.

**Do NOT trigger on**:
- Upload requests (*"upload this to the CDN"*, *"put this file on cdn.22d.app"*) → `cdn-file-upload` skill.
- Re-runs or partial repairs (*"my deploy broke"*, *"the CLI says X"*) → v1 is fresh-install only; debug as a regular conversation, don't re-enter the phase flow.
- Adding a second project to an already-deployed CDN → `cdn-file-upload` or the MCP tools directly.

## What the partner ends up with

- **Worker URL** — either `https://cdn-mcp.<their-domain>` (custom) or `https://cdn-mcp.<account-subdomain>.workers.dev` (default).
- **Public CDN URL prefix** — either `https://cdn.<their-domain>` or `https://pub-<hash>.r2.dev`.
- **Local `cdn` CLI** installed globally on the host, with `~/.cdn-cli/config.json` written (chmod 600).
- **Cowork custom connector** wired to the Worker URL, exposing 13 `cdn_*` MCP tools in fresh sessions.
- **`cdn-mcp-plugin` installed** in Cowork, which ships the `cdn-file-upload` skill for natural-language uploads.

## Constraints + the "complete in one session" recommendation

- **Cloudflare requires a credit card on file** even for the free tier. Personal use stays at $0; the card is for usage spikes. Warn the partner loudly before the R2 subscription click — first-time partners assume "free tier" means "no card." Reason: this is the single most common drop-off point during dashboard onboarding.
- **DNS propagation is 1–24 hours** if the partner is bringing a new domain to Cloudflare. The skill offers a workers.dev fallback so they can finish today and rebind to a custom domain later.
- **macOS is the primary tested target.** Linux scripts emit in the same shape and usually work (substitute `apt`/`dnf` for `brew`). Windows partners get an inline markdown instruction block for prereqs and a `.bat` for the CLI install + config write — not a full clickable flow. Tell Windows partners this up front.
- **The R2 API token's secret is shown ONCE** during creation (Phase A.4). If the partner misses it, they have to delete and recreate the token. Set expectations before the click.
- **Sandbox vs host.** Cowork's sandbox runs the skill, parses output, drives Chrome, and writes scripts. It cannot install anything on the partner's host, cannot reach external HTTPS (no `gh release download` from inside the sandbox), and cannot read files from the host filesystem. Every install or wrangler command runs inside a clickable script on the partner's machine.

**Recommended: complete setup in one Cowork session.** If the partner pauses and returns later, the skill asks where they left off and may request a host-side verification command (`curl`, `cdn version`) pasted back to confirm state. Resume is best-effort in v1 — no persistent state file. If the partner gets stuck mid-flow, the chat history in the project is the only memory.

## Versions pinned in this skill

```
CDN_CLI_VERSION   = v0.1.0
CDN_CLI_TGZ_NAME  = 22d-cdn-cli-0.1.0.tgz
PLUGIN_VERSION    = plugin-v0.3.1
PLUGIN_FILE_NAME  = cdn-mcp-plugin.plugin
```

These are bumped in lockstep when Phase 10.1+ ships new releases. Do not use `--latest` or `gh release list` to discover the newest — version drift across A/D/F would break resume detection and the structured pasteback.

## How this skill is structured

Six phases, each with a single clear deliverable:

| Phase | Deliverable | Surface |
|---|---|---|
| **A** | Account, R2, domain decision, optional R2 keys | Chrome MCP or manual |
| **B** | Node, git, gh, wrangler installed + authed | Clickable `.command` |
| **C** | Worker + R2 bucket + D1 deployed; secrets set | Clickable `.command` + structured pasteback |
| **C.5/C.6** | Custom domain bound (optional) | Chrome MCP or manual + clickable `.command` |
| **D** | CLI installed, config written, plugin downloaded | Clickable `.command` |
| **E** | Cowork custom connector added | Chrome MCP or manual |
| **F** | Plugin installed in Cowork + smoke test in fresh session | `present_files` (partner) + hand-off |

State flows in chat across phases. After each phase, restate to the partner what's been captured and ask them to confirm before generating the next script.

## Chrome MCP try-then-fallback pattern

This applies to every dashboard-driven step: Phase A.1–A.4, Phase C.5, Phase C.6, Phase E.

**Detection (do this once, at skill start)**:

Try the Chrome MCP browser tool with a benign call (e.g., `list_connected_browsers` or equivalent for whichever Chrome MCP variant is wired in this session). Three outcomes:

1. **Tool not in available tools at all** → Chrome MCP is not loaded. Fall back to manual for all dashboard steps.
2. **Tool available, returns empty connected list** → Chrome MCP loaded but no browser attached. Tell the partner: *"I can drive your browser if you connect Chrome MCP (link to setup if you have one). Otherwise I'll give you click-by-click instructions."* Accept their answer.
3. **Tool available, browser connected** → drive it. Announce: *"Chrome MCP detected — I'll drive the dashboard. If anything errors (layout change, login expired), I'll switch to manual instructions mid-flow."*

**During driving**: take screenshots between major actions so the partner can sanity-check. Catch any tool error — DOM not found, navigation timeout, auth redirect — and switch to manual for that step. Do not retry blindly; Cloudflare's UI changes frequently and brittle CSS selectors are a dead end.

**Manual fallback content** is what the skill would have done by hand: exact URL, exact button name visible to the human, exact value to copy back into chat. Phrase as a numbered list. End with: *"Paste back when done"* or *"reply with the value when you have it."*

**Never pretend Chrome MCP works when it doesn't.** Detect cleanly, fall back cleanly, do not silently spin.

## Sandbox capability pre-flight

Before Phase A, confirm:

1. **`mcp__cowork__present_files` is available.** Without it the skill cannot ship clickable scripts. If missing: stop and tell the partner *"this skill needs Cowork's `present_files` tool, which I don't see in this session. Open a Cowork-supported chat and re-run."*
2. **Bash works in sandbox** (basic `echo`, `mkdir`, write to a path). Smoke-test with a one-line write to the outputs folder.
3. **Chrome MCP availability** (informational, not blocking). Report mode to the partner: *"Chrome MCP: detected/not detected. Dashboard steps will be: driven/manual."*
4. **Sandbox egress is blocked** — do not try `curl` or `gh release download` from the sandbox at any point in this skill. All external fetches happen inside clickable scripts on the partner's host.

## Resume detection (pause/resume across sessions)

On skill entry, ask: *"Have you started cdn-mcp setup before in another Cowork session? If yes, which phases did you finish?"*

If the partner indicates partial completion, ask them to run **on their host** the probes that match the claimed state:

| Claimed state | Host-side probe | Pass = |
|---|---|---|
| Phase B done | `node --version && wrangler --version && gh --version` | Three versions returned |
| Phase C done | `curl -s https://<their-worker-url>/health` | `{"status":"ok",...}` |
| Phase D done | `cdn version` | `0.1.0` |
| Phase E done | Partner opens fresh Cowork session, tool picker shows 13 `cdn_*` | Partner confirms count |
| Phase F done | Partner asks Claude `/cdn-file-upload` in a fresh session, skill appears | Partner confirms |

Partner pastes back probe output. Skill skips phases that probe-confirmed; resumes at the next incomplete one. **Do not auto-skip on partner's word alone** — always require a probe paste-back. Resume is fragile in v1; the partner's verification is the only reliable signal.

**If the partner lost their Worker URL** between sessions: recover from the CLI config — `cat ~/.cdn-cli/config.json | jq -r .mcp.url` returns the full URL with token. If Phase D never completed (no config file yet), the partner can re-derive from the Cloudflare dashboard → Workers & Pages → the `cdn-mcp` Worker → the listed URL under "Triggers." Tell them which path applies based on their claimed last completed phase.

If the partner cannot confirm a state, restart that phase from the top. Re-running a finished phase is safe (script generation is idempotent; `wrangler` commands are idempotent for the things this skill does).

---

## Phase A — Accounts & dashboard setup

Goal: capture the values needed for the deploy script. State held in chat:

- `cloudflare_account_id` (always; 32-hex)
- `cloudflare_zone_id` (only if custom domain on CF DNS)
- `domain` (custom-domain string, or `null` for workers.dev)
- `r2_access_key_id`, `r2_secret_access_key` (only if Phase A.4 ran)

### A.1 Cloudflare account

**Chrome-driven path**:
- Navigate to `https://dash.cloudflare.com`. If redirected to `/sign-up`, walk the partner through: email → password → verify email → return to dash.
- Once on the dashboard, grab the account ID from one of two places: the URL after a zone click (`https://dash.cloudflare.com/<account-id>/...`) or the right sidebar on the account home (under "API" → "Account ID").
- Read the value via Chrome MCP and confirm with the partner: *"I captured account ID `abc123...`. Is that right?"*

**Manual fallback**:
1. Open `https://dash.cloudflare.com/sign-up` (no account) or `https://dash.cloudflare.com` (existing).
2. Once signed in, click any zone or scroll to the right sidebar.
3. Copy the account ID and paste it back here.

**Pass/fail**: 32-character hex string captured.

### A.2 R2 subscription

> ⚠ **Cloudflare requires a credit card to enable R2.** Free tier stays $0 for personal use, but a card is required to unlock the service. Many partners stop here surprised — call it out before they click *Subscribe*.

**Chrome-driven path**:
- Navigate to `https://dash.cloudflare.com/?to=/:account/r2`.
- If the page shows "Purchase R2 Plan" or "Get Started," walk the partner through subscribing (free tier). Pause at the credit-card prompt — the partner must complete that themselves.
- Confirm post-subscribe state: page now shows "Create bucket" rather than the subscribe call-to-action.

**Manual fallback**:
1. Open `https://dash.cloudflare.com/?to=/:account/r2`.
2. Click *Purchase R2 Plan* (free tier) → complete the card-on-file flow.
3. Reply *"R2 subscribed"* when the page shows the bucket-creation UI.

**Pass/fail**: R2 dashboard shows bucket-creation enabled.

### A.3 Custom domain decision

Ask via `AskUserQuestion` (or equivalent):

> **Domain setup**: do you want clean URLs like `cdn.your-domain.com`, or are workers.dev defaults fine?
>
> - **Already on Cloudflare DNS** — domain is on Cloudflare nameservers; I'll capture the zone ID.
> - **Have a domain, not on Cloudflare yet** — I'll walk you through adding it; takes 1–24h for nameservers to propagate.
> - **Workers.dev defaults** — skip the custom domain entirely; you'll get `pub-xxx.r2.dev` URLs. You can bind a domain later.

**If "already on Cloudflare DNS"**:
- Chrome path: navigate to the domain's Overview page → right sidebar → capture zone ID.
- Manual: tell partner *open dashboard → click your domain → right sidebar shows zone ID → paste back.*

**If "have a domain, not yet on Cloudflare"**:
- Chrome path: walk through *Add a site* → enter domain → free plan → review DNS records → save → show nameserver values → tell partner to switch them at their registrar.
- Manual: numbered steps with the same flow.
- **Warn loudly**: *"Nameserver propagation can take up to 24 hours. I recommend finishing today on workers.dev URLs — you can rebind to your custom domain in a separate session once propagation completes. Continuing with workers.dev for now."*

**If "workers.dev defaults"**: capture `domain = null`. Skip C.5/C.6.

**Pass/fail**: either zone ID captured, or explicit workers.dev choice noted in chat.

### A.4 (Optional) R2 API token for files >100 MB

Ask via `AskUserQuestion`:

> **Will you ever upload files larger than ~100 MB?** (Videos, large datasets, big design files.) If yes, I'll capture R2 API keys now — they enable the CLI's large-file upload path. If no, you can add them later.

**If yes**:

> ⚠ **The R2 secret access key is shown only ONCE** during creation. Copy it the moment it appears, or you'll have to delete and recreate the token.

- Chrome path: navigate to `https://dash.cloudflare.com/?to=/:account/r2/api-tokens`. Click *Create API Token*. Set permissions to *Object Read & Write*. Specify bucket: the bucket name the partner will use (default `cdn-assets`). Submit. Read the access key ID and secret from the success page via Chrome MCP. Confirm capture with the partner *without echoing the secret back in chat*.
- Manual: numbered steps with same flow. Tell the partner: *"Paste the access key ID. Then paste the secret access key separately. I'll capture both and won't echo them back."*

**Capture rules** (apply for the rest of the session):
- Store `r2_access_key_id` and `r2_secret_access_key` in skill memory.
- Refer back as *"the R2 access key"* and *"the R2 secret"* — never reprint full values.
- These get baked into Phase C's deploy script (one-time-use on host) and Phase D's CLI config (chmod 600). They never appear in chat after capture.

**If no**: leave both empty. The CLI's `cdn upload` will fail until they're added; `cdn list`/`cdn projects`/`cdn stats` and Path A (MCP base64) uploads still work. Tell the partner this.

**Pass/fail**: keys captured, or explicit skip noted.

### Phase A wrap

Restate to the partner:

```
Phase A summary:
- Cloudflare account ID: <captured ✓>
- R2 subscription: active ✓
- Domain: <"custom: example.com" | "workers.dev (will bind later)" | "workers.dev (default)">
- Zone ID: <captured ✓ | n/a>
- R2 API keys: <captured ✓ | skipped (small-file uploads only)>
```

Ask: *"Ready to proceed to Phase B (install prerequisites on your machine)?"*

---

## Phase B — Install prerequisites (clickable script)

Goal: Node 20+, git, gh CLI, wrangler CLI installed and authed on the partner's host.

### OS detection

Inspect the workspace folder path Cowork is operating in (same logic as `cdn-file-upload/SKILL.md` lines 84–92):

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
2. **`chmod +x` the script** before `present_files`. Cowork preserves the executable bit through Save (confirmed at `cdn-file-upload/SKILL.md:192`).
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

Goal: Worker deployed; R2 bucket + D1 database created and migrated; secrets set; deployed URL captured.

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
5. `npx wrangler d1 create {{D1_DB_NAME}}` → captures the `database_id` from output with a `sed`/`grep` regex → patches `wrangler.toml`.
6. `npx wrangler d1 migrations apply {{D1_DB_NAME}} --remote`.
7. `TOKEN=$(openssl rand -hex 32)` → `echo "$TOKEN" | npx wrangler secret put MCP_AUTH_TOKEN`.
8. If `{{R2_ACCESS_KEY_ID}}` is non-empty, also sets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` as secrets.
9. `npm run deploy`.
10. Parses the deployed URL from wrangler's output (look for the `https://...workers.dev` or custom-route URL line).
11. (workers.dev partners only) Attempts to derive the public R2 dev URL via `wrangler r2 bucket dev-url enable`/`get`. If the subcommand fails (syntax has shifted across wrangler versions), the script falls back to `https://pub-PENDING.r2.dev` and the partner can grab the real value manually from **Cloudflare dashboard → R2 → the bucket → Settings → Public R2.dev Bucket URL → "Allow Access" → copy the URL** — then update `~/.cdn-cli/config.json`'s `publicUrlPrefix` and re-set the Worker's `PUBLIC_URL_PREFIX` var (one redeploy) so future `cdn_upload_file` calls return the right URLs.
12. Runs the inline smoke test (next section).
13. Echoes the structured pasteback block.

### Inline smoke test (runs on host before pasteback)

```bash
echo "→ Smoke test: /health"
HEALTH=$(curl -s "https://$WORKER_HOST/health")
echo "$HEALTH"
echo "$HEALTH" | grep -q '"status":"ok"' || { echo "✗ Health check failed"; exit 1; }

echo "→ Smoke test: MCP tools/list"
TOOL_COUNT=$(curl -s -X POST "https://$WORKER_HOST/mcp/$TOKEN" \
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
MCP_AUTH_TOKEN: 64hexcharsover64hexcharsover64hexcharsover64hexcharsover64hex
R2_BUCKET: cdn-assets
D1_DATABASE_ID: 8400e8c0-1c5e-4f1d-9eaa-aa3b41c5e9d4
PUBLIC_URL_PREFIX: https://pub-abc123.r2.dev
=== END ===
```

Skill parses this block with a simple regex (`^([A-Z_]+): (.+)$` between the delimiters) and captures all five values into chat state.

> ⚠ **The MCP_AUTH_TOKEN appears in this block once** so the partner can save it to a password manager. After capture, the skill does not echo the token back — references in later messages use `<your MCP token>` or similar.

### Flow

1. Write script to outputs folder, `chmod +x`, `present_files`.
2. Tell partner:

   > Double-click `02-deploy-worker.command`. This takes 3–5 minutes: clone, install, create R2 bucket, create D1 database, apply migrations, generate auth token, deploy Worker, smoke-test, and print a paste-back block.
   >
   > **Save the `MCP_AUTH_TOKEN` from the paste-back block to your password manager** — you'll see it once and we won't print it again.
   >
   > Paste the entire `=== CDN-SETUP DEPLOY OUTPUT ===` block back when done.

3. Wait for paste-back. Parse.
4. Confirm to partner: *"Got it. Worker is at `<url>`; public URLs will be served from `<prefix>`. Proceeding to Phase D."* (Or to C.5/C.6 if custom domain.)

**Pass/fail**: pasteback parsed; all five values captured; smoke test reported ✓ inside the script output.

### Phase C.5 — (custom domain only) R2 custom domain binding

Skip unless A.3 chose a custom domain.

**Chrome-driven path**: navigate to `https://dash.cloudflare.com/?to=/:account/r2/buckets/{{R2_BUCKET_NAME}}/settings`. Scroll to *Custom Domains* → *Connect Domain*. Enter the subdomain (e.g., `cdn.example.com`). Cloudflare auto-creates the CNAME on the zone. Wait ~2 minutes for SSL provisioning.

**Manual fallback**: numbered steps to the same UI.

**Verify**: tell partner to run on host: `curl -I https://cdn.<their-domain>`. Expect a 200 or Cloudflare 404 (cert is live). Paste output back.

**Update state**: set `PUBLIC_URL_PREFIX = "https://cdn.<domain>"` in chat state (overrides whatever Phase C captured).

### Phase C.6 — (custom domain only) Worker route + DNS record + redeploy

Skip unless A.3 chose a custom domain.

**Add DNS A record**:
- Chrome path: dashboard → domain → DNS → Records → *Add record*. Type A, Name `cdn-mcp` (or partner's chosen subdomain), IPv4 `192.0.2.1` (TEST-NET-1; never reached; Cloudflare's edge intercepts via the Worker route), Proxy status *Proxied* (orange cloud).
- Manual: same numbered steps.

**Then run the redeploy script**:

Generated from `scripts/02b-bind-route-redeploy.command.template`. Substitutes `{{ZONE_ID}}` and `{{ROUTE_PATTERN}}` (e.g., `cdn-mcp.example.com/*`). The script uncomments the `route` block in `~/cdn-mcp/wrangler.toml` with the right values, then runs `npm run deploy` again.

**Verify**: partner runs `curl -s https://cdn-mcp.<their-domain>/health` → expect `{"status":"ok",...}`. Paste back.

**Update state**: set `WORKER_URL = "https://cdn-mcp.<domain>"` (overrides Phase C value).

---

## Phase D — Install CLI + download plugin (clickable script)

Goal: `cdn` CLI installed globally; `~/.cdn-cli/config.json` written with all values; `cdn-mcp-plugin.plugin` downloaded to `~/Downloads/` for Phase F.

### Script content

Generated from `scripts/03-install-cli.command.template`. Substitutes:

- `{{CDN_CLI_VERSION}}` = `v0.1.0`
- `{{CDN_CLI_TGZ_NAME}}` = `22d-cdn-cli-0.1.0.tgz`
- `{{PLUGIN_VERSION}}` = `plugin-v0.3.1`
- `{{PLUGIN_FILE_NAME}}` = `cdn-mcp-plugin.plugin`
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
6. Download the plugin: `gh release download {{PLUGIN_VERSION}} --repo code22d/cdn-mcp --pattern "*.plugin" --dir ~/Downloads`.
7. Echo `=== PHASE D COMPLETE ===` with the absolute path of the downloaded `.plugin` file.

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

If A.4 was skipped, `accessKeyId` and `secretAccessKey` are empty strings — `cdn upload` will fail until they're added, but everything else works.

### Windows variant

For Windows partners, emit `03-install-cli.bat` from a separate template (same substitutions; cmd-syntax heredoc; uses `mkdir %USERPROFILE%\.cdn-cli`, `echo > %USERPROFILE%\.cdn-cli\config.json`, `icacls` for the equivalent of `chmod 600`). Plugin downloaded to `%USERPROFILE%\Downloads\`. Partner double-clicks the `.bat`.

### Fallback if `gh release download` fails on the partner's host

If the script's `gh release download` step errors (network issue, gh-auth expired, release renamed), tell the partner:

> Looks like `gh release download` failed. You can download both files directly in your browser:
>
> - **CLI**: https://github.com/code22d/cdn-cli/releases/download/v0.1.0/22d-cdn-cli-0.1.0.tgz → save to your Downloads, then run `npm install -g ~/Downloads/22d-cdn-cli-0.1.0.tgz`
> - **Plugin**: https://github.com/code22d/cdn-mcp/releases/download/plugin-v0.3.1/cdn-mcp-plugin.plugin → save to your Downloads
>
> Once both are in place, reply "downloaded" and I'll continue.

The skill resumes from step 3 (config write) when the partner confirms.

### Flow

1. Generate script (or `.bat` for Windows). `chmod +x` if `.command`/`.sh`.
2. `present_files`.
3. Tell partner what to expect (~30 seconds runtime; outputs a path).
4. Wait for paste-back of `=== PHASE D COMPLETE ===` block including the plugin path.
5. Capture `PLUGIN_PATH` into chat state.

**Pass/fail**: pasteback shows `cdn version` returned `0.1.0`, `cdn projects` returned `[]` or a list, and the plugin file path is non-empty.

---

## Phase E — Cowork connector (Chrome MCP or manual)

Goal: a custom connector wired to the partner's Worker URL is registered in claude.ai. After this, fresh Cowork sessions expose 13 `cdn_*` MCP tools.

### Chrome-driven path

Navigate to `https://claude.ai/settings/connectors` (or wherever the current claude.ai routes Settings → Customize → Connectors). Click *Add custom connector*. Fill:

- **Name**: `cdn-mcp`
- **URL**: `{{WORKER_URL}}/mcp/{{MCP_AUTH_TOKEN}}`

Submit. Take a screenshot of the post-save state for the partner.

### Manual fallback

> 1. Open https://claude.ai → click your profile → Settings → Customize → Connectors → **Add custom connector**.
> 2. Name: `cdn-mcp`
> 3. URL: `<paste here — I'm not echoing the token, but the script you ran in Phase C printed it; copy the full URL from `~/.cdn-cli/config.json` 's `mcp.url` field if you need to: cat that file in your terminal>`.
> 4. Save.
> 5. Reply *"connector added"* when done.

### Verification

The skill cannot directly verify in the current session — the connector loads on session start and this session predates the add. Tell the partner:

> Open a **fresh** Cowork session, open the tool picker, and confirm 13 tools starting with `cdn_` appear (`cdn_help`, `cdn_upload_file`, `cdn_list_files`, ...). Reply with the count.

**Pass/fail**: partner reports 13 `cdn_*` tools visible in a fresh session.

If the partner reports fewer than 13 or zero tools: the URL or token in the connector doesn't match the Worker's secret. Ask them to re-check the URL pasted into the connector against `cat ~/.cdn-cli/config.json | jq -r .mcp.url`. If mismatched, edit the connector. If matched and still failing, ask them to run `npx wrangler tail` from `~/cdn-mcp` in a separate terminal and try the connector again — the tail will print the request and the auth failure reason.

---

## Phase F — Install plugin + smoke-test hand-off

Goal: `cdn-mcp-plugin` installed in Cowork; first end-to-end upload completes in a fresh session.

### Plugin install (in this session)

Tell the partner:

> Open a Cowork session (this one works, or a fresh one — either way) and tell Claude:
>
> > *Install this plugin: `{{PLUGIN_PATH}}`*
>
> Cowork will call `present_files` on the `.plugin` file and show it as a card. Click **Save plugin** on the card. The plugin installs.

(The skill itself does not call `present_files` on the plugin — it's not in the skill's outputs folder; it's on the partner's host at the path Phase D printed. The partner's next request to Claude — *"install this plugin: <path>"* — is what surfaces it.)

### Smoke test (fresh Cowork session, NOT this one)

Tell the partner:

> Once the plugin shows as installed, **open a fresh Cowork session** (so the new skill loads). In the fresh session:
>
> 1. On your host, create a test file: `echo "hello from my new CDN" > /tmp/hello.txt`
> 2. In Cowork, say: *"Upload `/tmp/hello.txt` to project test on the CDN"*
> 3. The `cdn-file-upload` skill should detect the file as small (412 bytes), upload via MCP, and print the public URL.
> 4. Verify on host: `curl <printed-url>` → returns `hello from my new CDN`.
>
> Come back here and report the URL when done — I'll print the success summary.

Wait for the partner to report the URL.

### Success summary

Once smoke test passes, print:

```
✅ Personal CDN live.

  Worker:           {{WORKER_URL}}
  Public URL base:  {{PUBLIC_URL_PREFIX}}
  First upload:     <url-the-partner-reported>
  CLI configured:   ~/.cdn-cli/config.json (chmod 600)
  Plugin installed: {{PLUGIN_PATH}}

Next steps:
  - Run `cdn help` for CLI commands
  - Read https://github.com/code22d/cdn-mcp/blob/main/README.md for daily-use
  - Try a large upload (>1 MB) in Cowork to exercise the clickable-script path
  - Cloudflare dashboard → R2/D1/Workers to watch usage

If you stop seeing the `cdn_*` tools later: claude.ai → Settings → Connectors → cdn-mcp → "Refresh tools."
```

**Pass/fail (overall skill)**: partner reports a working public URL.

---

## Credentials handling rules

Three secrets are touched during setup:

| Secret | Source | Lives at | Re-show? |
|---|---|---|---|
| `MCP_AUTH_TOKEN` | Generated in Phase C deploy script | Cloudflare (Worker secret) + `~/.cdn-cli/config.json` | Once in Phase C pasteback; never after |
| `R2_ACCESS_KEY_ID` | Phase A.4 R2 token creation | Cloudflare (Worker secret if A.4 ran) + `~/.cdn-cli/config.json` | Captured once; referred to as "your R2 access key" thereafter |
| `R2_SECRET_ACCESS_KEY` | Phase A.4 (UI shows once) | Same as above | Never echoed back to chat after capture |

**Rules**:
- After capture, refer back as *"your MCP token"*, *"your R2 access key"*, *"your R2 secret"*. Do not reprint full values.
- Bake into the deploy script (Phase C) and CLI config script (Phase D) at generation time. These scripts are one-time-use on the partner's host.
- Do not write standalone credential files into the outputs folder — only the install/deploy scripts that embed them at execution time and exit.
- The Phase D CLI config script `chmod 600`s `~/.cdn-cli/config.json` so other users on the same machine cannot read it.

If a secret leaks: rotate fast. `openssl rand -hex 32` for a new token; `npx wrangler secret put MCP_AUTH_TOKEN`; update the connector URL in claude.ai and `~/.cdn-cli/config.json` to match. For R2 keys, delete and recreate in the dashboard. Total time ~2 minutes.

## Sandbox vs host — what runs where

| Activity | Sandbox (Cowork) | Host (partner's machine) |
|---|---|---|
| Script generation, pasteback parsing, state tracking | ✓ | — |
| Chrome MCP dashboard driving | ✓ | — |
| `present_files` (surface scripts and plugin) | ✓ | — |
| `chmod +x` on emitted scripts | ✓ | — |
| External HTTPS (`curl`, `gh release download`) | ✗ blocked | ✓ |
| `git clone`, `npm install`, `wrangler` commands | ✗ blocked | ✓ |
| `wrangler login`, `gh auth login` (browser auth) | ✗ blocked | ✓ |
| Reading partner's `~/.cdn-cli/config.json` | ✗ no host access | ✓ |

Rule: anything that needs network, install permissions, or the partner's filesystem runs inside a clickable script the partner executes. The skill never tries to bypass this — `cdn-file-upload/SKILL.md:408` documents the sandbox HTTPS block and the same constraint applies here.

## OS support matrix

| OS | Phase B prereqs | Phase C deploy | Phase D CLI install | Notes |
|---|---|---|---|---|
| **macOS** | `.command` (full) | `.command` (full) | `.command` (full) | Primary tested target |
| **Linux** | `.sh` (`apt`/`dnf`) | `.sh` (same as Mac) | `.sh` (same as Mac) | Tested less; usually works |
| **Windows** | Markdown chat block | Markdown chat block (or hand-translate) | `.bat` | Heaviest manual work; warn partner up front |

Tell Windows partners during Phase A wrap: *"Windows partners get an inline instruction block for Phase B + most of Phase C — only Phase D has a clickable. Heavier hands-on than Mac/Linux. Continue, or move to a Mac if you have one?"*

## What this skill does NOT do

- **Do not ship pre-baked scripts** in the .skill package. Every script is generated per partner with their values substituted at runtime. Pre-baked scripts would leak inappropriate defaults and prevent Phase A→C value flow.
- **Do not auto-install the plugin via Chrome MCP** or any other automation. Cowork plugin installs go through `present_files` + the partner's Save click. That's the only supported flow.
- **Do not make Phase F's smoke test happen in the current session.** The connector loads on session start; it must be a fresh Cowork session to see the new tools.
- **Do not hardcode brittle CSS selectors** in Chrome-driven dashboard steps. Use visible button names and accessible labels; on any error, fall back to manual. Cloudflare and claude.ai re-skin frequently.
- **Do not skip account setup** for partners who already have a Cloudflare account but no cdn-mcp deploy. v1 = fresh install only. Re-runs are out of scope; debug as a regular conversation.
- **Do not `curl` from sandbox** to verify the deployed Worker. Sandbox egress is blocked. The inline smoke test in Phase C runs on host; the partner pastes the result back.
- **Do not log secrets to chat** after first capture. Never reprint `MCP_AUTH_TOKEN` or R2 keys.
- **Do not modify the partner's repo or host files** outside the deploy/install scripts the partner explicitly runs.
- **Do not try to detect installed prerequisites** (`which node`, `which cdn`) from inside the sandbox — host binaries are not visible. The clickable script does the detection on host.

## References

- `PARTNER-SETUP.md` (this repo) — manual long-form walkthrough; orientation reading for the partner if they want to understand every step.
- `INSTALL-WITH-CLAUDE.md` (this repo) — the former Claude Code–driven flow that this skill replaces in Cowork. Phase 10.1+ will retire this doc.
- `skills/cdn-file-upload/SKILL.md` — companion skill that takes over after Phase F for uploads. Source of OS-detection logic, executable-bit handling, and sandbox-egress constraints used here.
- `README.md` (this repo) — daily-use commands and tool reference for after setup.
- `cdn_help` MCP tool — once the connector is live, this tool returns architecture orientation inline.

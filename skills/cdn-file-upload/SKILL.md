---
name: cdn-file-upload
description: Upload files of any size or type to Rene's personal CDN at cdn.22d.app. Use whenever the user wants to host, upload, or publish files on the CDN — explicit phrasings like "upload to cdn.22d.app", "host on the CDN", "push to the CDN", "put it on the CDN", "save to my CDN", "stage this file", "host this", "push this to prod", "deploy this asset", "share this via CDN", "share this publicly", and bare phrasings like "upload", "upload it", "upload this" once the conversation has established that a file is CDN-bound. The skill probes sandbox network egress every session and adapts — with egress it uploads zero-click via signed R2 URL + direct PUT + finalize; without it, it generates a clickable script (.command/.sh/.bat) running the local `cdn` CLI. Never `cdn_upload_file`, never base64. Sanitizes unsafe filenames (with preview) and verifies the public URL after. Do NOT fire for uploads to other systems (GitHub, Slack, Drive, Notion, S3, Dropbox, iCloud) — only cdn.22d.app / the cdn-mcp connector.
---

# cdn-file-upload

Upload single files or batches of any size or type to the personal CDN at `cdn.22d.app`.

This skill is **adaptive**. Cowork sandboxes differ in whether they can reach the network, and that changes what the best upload transport is. So the skill probes, then branches:

```
User asks to upload
        │
        ├─ run the network-egress probe (every session, never cached)
        │
        ├── Egress OK  +  source file readable from the sandbox
        │      └─→ ZERO-CLICK: signed URL → curl PUT → finalize → HEAD verify → report URL
        │          (no user interaction after the project/name confirmation)
        │
        └── Egress blocked  OR  source not sandbox-readable
               └─→ PATH E FALLBACK: generate a clickable .command/.sh/.bat script,
                   user double-clicks, skill verifies after
```

Both branches end at the same place: the file is live at `https://cdn.22d.app/<project>/<name>` and the skill has verified it. Neither branch ever base64-encodes anything.

The companion `cdn_help` MCP tool documents the CDN architecture if you need orientation. This skill is for *executing* uploads, not explaining them.

## What NOT to do

If the user asks you to upload a file to the CDN, **do not**:

1. **Do NOT call `cdn_upload_file`.** Not for small files, not "just this once," not because the user named the tool. Base64-through-the-MCP is the wrong transport in every branch of this skill. As of Worker Phase 11.3 the tool hard-rejects external callers anyway — calling it returns an error, not an upload.
2. **Do NOT base64-encode the file.** Regardless of size. Regardless of "chunk it into 5000-char lines." Regardless of subagent fan-out. No base64 anywhere, in any path.
3. **Do NOT chunk the file into pieces**, fold it, split it across `/tmp` files, or print encoded bytes into your transcript. If you find yourself writing `base64` in a bash command, stop — you are in the anti-pattern.
4. **Do NOT skip the probe.** Every upload starts with the egress probe. Don't assume egress from a prior turn, a prior session, or a prior upload is still valid — see *Network egress probe* below for why.
5. **Do NOT spawn subagents to "keep session context lean."** The zero-click path is a couple of native `curl` calls; there is no context to save. The Path E path is a script the *user's host* runs. Neither one puts bytes in your context.
6. **Do NOT clone the cdn-mcp repo, inspect workflow files, or push temp branches.** The skill is complete and self-contained; there is no hidden "alternative path" to discover in the source.

**What you SHOULD do:** probe, then either upload it yourself (zero-click) or hand the user a clickable script (Path E). That's the whole skill.

If you find yourself considering any of the "do not" patterns above, STOP and re-read this section.

## Network egress probe

Cowork's egress allowlist is per-session: it only applies to sessions **started after** the user changed the setting. So reachability genuinely varies session to session, and a cached answer from last time is worthless. **Probe at the start of every upload.**

```bash
curl -sI --max-time 10 https://cdn.22d.app/
```

Interpret it:

| Result | Meaning | Branch |
| --- | --- | --- |
| A real origin response — any HTTP status, with `server: cloudflare` among the headers | Egress reachable | Try **zero-click** |
| Response header `X-Proxy-Error: blocked-by-allowlist` | Proxy refused it | **Path E** |
| `curl` exits with a network error or times out | Not reachable | **Path E** |
| No shell available at all | Can't probe, can't PUT | **Path E** |

The probe is cheap (~200ms typical) and safe: a public unauthenticated GET with no side effects.

**One probe is not enough, though.** `cdn.22d.app` is only the *verification* host (zero-click step 6). The actual byte transfer PUTs to the presigned R2 endpoint — `<account>.r2.cloudflarestorage.com` — which is a **different host behind its own allowlist entry**. Verified live on 2026-07-12: `cdn.22d.app` reachable while the R2 host's CONNECT was still refused. So the `cdn.22d.app` probe is a first gate (if it fails there's no point minting a signed URL), and the PUT leg is checked separately at step 4, where a blocked PUT falls back to Path E rather than dead-ending.

For zero-click to work end to end, the Cowork egress allowlist needs **both** hosts:

- `cdn.22d.app`
- `1ca89091477fe859962f0e9a14e8942e.r2.cloudflarestorage.com`

(Both exact hosts are proven to work. Use `*.r2.cloudflarestorage.com` only if the settings UI accepts wildcards.) Allowlist changes apply only to sessions started after the change — the same reason the probe is per-session.

## Pre-flight checks (do these first, every time)

1. **The user has specified what to upload.** A file path, a directory, or attached files. If unclear, ask before guessing.
2. **The user has specified a target project.** The project is the first path segment in the public URL (`cdn.22d.app/<project>/<filename>`). If not specified, ask: *"Which CDN project should I upload to? (e.g., `blog`, `videos`, `proposals`, `decks`)"* Project names match `^[a-zA-Z0-9_-]+$`, max 64 chars — no dots, no spaces.
3. **The cdn-mcp connector is reachable** (tools like `cdn_get_stats`, `cdn_signed_upload_url` appear in the available tools). The zero-click path *requires* it (that's where the signed URL comes from). Path E does not — the script talks to R2 via the CLI's own credentials — but post-upload verification does. If the connector is missing entirely, go to Path E and tell the user: *"The cdn-mcp connector isn't configured in this session, so I'll rely on the script's own curl verification instead of `cdn_get_stats`. Add the connector via claude.ai → Settings → Connectors when you get a chance."*

## Filename sanitization (both paths)

Before uploading or generating a script, check the **source basename** for characters outside `[a-zA-Z0-9._-]` — spaces, parentheses, brackets, ampersands, hash, percent, unicode glyphs, anything that doesn't URL-encode cleanly.

- **Basename is already clean** → skip this section entirely. No warning, no preview.
- **Basename contains unsafe characters** → replace **each** unsafe character with `_`, then show the user the proposed name BEFORE proceeding:

  ```
  The filename contains characters that don't URL-encode cleanly. I'll upload it as:

  `<sanitized-name>`

  Reply with a different name if you want, otherwise I'll proceed.
  ```

  Wait briefly for an objection; if the user supplies a different name, validate it against the same character set and use theirs.

Examples:

- `design-your-future_t20_EOpVA1 copy.jpg` → `design-your-future_t20_EOpVA1_copy.jpg`
- `Q3 Report (FINAL).pdf` → `Q3_Report__FINAL_.pdf`
- `スクリーンショット.png` → `_____.png` (all-glyph names degrade hard — this is the case where you should proactively suggest a meaningful name instead, e.g. `screenshot.png`)

The sanitized name is what lands on the CDN and what appears in the public URL: `https://cdn.22d.app/<project>/<sanitized-name>`. For **discrete-file batches**, apply the check per file — one preview message listing all renames, one confirmation.

## Zero-click path (probe passed)

Run this end to end. After the project/name confirmation there are no user steps.

### 1. Confirm the source is sandbox-readable

The file must be readable from *this* sandbox — a mounted folder path (`~/Documents/Claude/Projects/<mounted>/…`) or a chat-attachment path. `ls -l "<path>"` it.

**If it isn't there, ABORT the zero-click branch and fall back to Path E.** Non-negotiable: `curl -T` on a path the sandbox can't see fails, and the upload silently never happens. A file on the user's Desktop that Cowork hasn't mounted is a Path E job no matter how good the egress is.

### 2. Sanitize the target name

Per *Filename sanitization* above. Show the preview, let the partner override.

### 3. Mint a signed upload URL

Call `cdn_signed_upload_url` with:

- `project` = the confirmed project
- `name` = the sanitized name
- `content_type` = MIME guessed from the extension

It returns an `upload_url` (a presigned R2 PUT, valid 15 minutes — default `expires_in_seconds` is 900) and a `required_headers` map.

If it returns `file_exists`, the name is taken. Ask the partner whether to overwrite; on yes, re-call with `replace: true` (same semantics as the CLI's `--replace`).

### 4. PUT the bytes

Send **every** header in `required_headers`, byte-identical:

```bash
curl -sS --max-time 60 -X PUT -T "<source-path>" \
  -H "Content-Type: <mime>" \
  -H "Cache-Control: <value from required_headers>" \
  "<upload_url>"
```

- As of the deployed Worker, `required_headers` contains **both** `Content-Type` **and** `Cache-Control: public, max-age=60` (the presign signs `X-Amz-SignedHeaders=cache-control;content-type;host` — verified against a live presign 2026-07-12). Omit either header and R2 returns **403 SignatureDoesNotMatch**, even with perfectly open egress. Don't hand-pick headers; send what the response gave you.
- **Derive the PUT host from the returned `upload_url` at runtime — never hardcode it.** Today it's always `<account>.r2.cloudflarestorage.com` (the Worker presigns against the R2 S3 endpoint, never a Worker route), but read it off the URL.
- Optionally pre-check that host with `curl -sI --max-time 10 https://<upload-url-host>/` using the same interpretation table as the probe, before transferring bytes.
- **If the PUT (or the pre-check) fails with a network/proxy error even though the probe passed, fall back to Path E.** This is a real, observed configuration — `cdn.22d.app` allowlisted, R2 endpoint not. Don't dead-end, don't retry forever, don't reach for base64. Just switch branches.
- An abandoned presign is harmless: no D1 row exists until finalize, so the failed attempt leaves nothing behind.

Capture the response headers (`ETag`, `x-amz-version-id`) for logging.

### 5. Finalize the metadata

Call `cdn_finalize_upload` with exactly its four required fields:

- `project`
- `name` (sanitized)
- `content_type` (the same MIME used in steps 3–4)
- `size_bytes` (measured from the source file, e.g. `stat -f%z` / `wc -c`)

The inputSchema is FROZEN — **there is no ETag parameter.** The ETag from step 4 is for your logs only. Finalize `head()`s the R2 object and verifies the size matches before writing the D1 row, so a wrong `size_bytes` fails loudly rather than recording a lie.

### 6. HEAD-verify the public URL

```bash
curl -sIf --max-time 5 https://cdn.22d.app/<project>/<sanitized-name>
```

Must return 2xx. If it doesn't, say so plainly — do **not** report success on an unverified upload.

### 7. Report the URL

```
✅ Uploaded — https://cdn.22d.app/<project>/<sanitized-name>
```

**The public URL is deterministic** — `https://cdn.22d.app/<project>/<name>` — so you know it before the upload even starts. No need to parse it out of the finalize response. Present it as a clickable link.

## Path E — clickable upload script (fallback)

Use this when the probe fails, when the PUT is blocked, or when the source file isn't sandbox-readable. It's no longer the default, but nothing about it has changed — it is still a complete, reliable upload path.

The skill writes a small double-clickable script that runs the `cdn` CLI on the user's host. The user opens it from Finder/Explorer; their Terminal runs `cdn upload` (which streams bytes from disk to R2 with no payload caps) and then HEAD-checks the public URL. The skill verifies via `cdn_get_stats` once the partner reports back.

### Resolve paths first

If the user said `~/decks/q2.png`, expand `~` and any relative segments before writing the script. The user's terminal `cwd` is not the sandbox `cwd`, so a relative path can land in the wrong place. Always embed absolute paths.

### OS detection

Inspect the user's workspace folder path (the absolute path of the mounted folder Cowork is operating in):

- Starts with `/Users/` → **macOS** → emit `.command`
- Starts with `/home/` → **Linux** → emit `.sh`
- Contains a backslash, or matches `^[A-Za-z]:` (drive letter) → **Windows** → emit `.bat`
- Anything else / ambiguous → emit **all three**

Never ask the user what OS they're on — the workspace path is reliable, and emitting all three is the cheap fallback (~500 bytes each).

### Script naming

- Single file: `upload-<sanitized-source-filename>.<ext>` (e.g. `upload-q2-demo.mp4.command`).
- Batch: `upload-<project>-batch.<ext>` (e.g. `upload-decks-batch.command`).
- The script's own filename always uses the sanitized form (replace `[^A-Za-z0-9._-]` with `_`).

### Script templates

`.command` (macOS) and `.sh` (Linux) are identical bash. `<public-name>` is the sanitized name when sanitization applied, otherwise the original basename. Include `--name "<public-name>"` only when it differs from the source basename.

```bash
#!/bin/bash
# Auto-generated by cdn-file-upload skill.
# Uploads <filename> to project <project> on cdn.22d.app.

set -e
export PATH="$HOME/.npm-global/bin:$PATH"

echo "Uploading <filename> to project <project>…"
echo ""

cdn upload "<project>" "<absolute-path-to-file>" --name "<public-name>"

echo ""
echo "Verifying file is live…"
if curl -sIf -o /dev/null "https://cdn.22d.app/<project>/<public-name>"; then
  echo "✓ Verified: https://cdn.22d.app/<project>/<public-name>"
else
  echo "⚠ Upload reported success but verification failed."
  echo "  The file may take a moment to propagate. Run: cdn list <project>"
fi

echo ""
echo "Press any key to close…"
read -n 1
```

`.bat` (Windows):

```batch
@echo off
REM Auto-generated by cdn-file-upload skill.
REM Uploads <filename> to project <project> on cdn.22d.app.

echo Uploading <filename> to project <project>...
echo.

cdn upload "<project>" "<absolute-path-to-file>" --name "<public-name>"
if errorlevel 1 (
  echo.
  echo Upload failed. See error above.
  pause
  exit /b 1
)

echo.
echo Verifying file is live...
curl -sIf -o nul "https://cdn.22d.app/<project>/<public-name>"
if errorlevel 1 (
  echo Upload reported success but verification failed. File may take a moment to propagate.
  echo Check: cdn list ^<project^>
) else (
  echo Verified: https://cdn.22d.app/<project>/<public-name>
)

echo.
pause
```

Notes on the templates:

- `export PATH="$HOME/.npm-global/bin:$PATH"` is belt-and-suspenders. A double-clicked `.command` opens a new login shell that should source `.zshrc`, but the explicit PATH guarantees the `cdn` binary is found even if shell init is unusual.
- `curl -sIf` uses `--fail` so the exit code reflects HTTP success directly — no http_code parsing, same pattern across Mac/Linux/Windows. (curl ships with Win10+ by default.)
- The verification HEAD request is unauthenticated. Public URLs at `cdn.22d.app/<project>/<filename>` are world-readable — no secrets in the script.
- `read -n 1` (bash) / `pause` (.bat) keeps the window open so the user sees the result.

### CLI flags inside the script

- `--name <sub/path/file.ext>` sets the CDN-side name — used for sanitization and for organizing under a sub-path within the project. Accepts forward slashes (e.g. `2026-05/hero.png`), but no leading slash, no leading dot, no `..` segments.
- `--replace` if overwriting an existing file at the same name.

`cdn upload-dir` (directory batches) accepts `--prefix`, `--include`/`--exclude` globs, `--concurrency`, and `--replace`.

### Batches

- **Source is a directory** → a single `cdn upload-dir "<project>" "<absolute-dir-path>"` line. Skip per-file `curl` verification in the script and rely on `cdn_get_stats` after — the stats delta is the canonical check. (Check for unsafe basenames first. The CLI keeps original names on `upload-dir` and `--name` doesn't apply, so unsafe basenames must be uploaded individually with `--name`, or renamed at the source.)
- **Source is a list of discrete files** → multiple `cdn upload` lines back-to-back, then a loop of `curl -sIf` checks. `set -e` halts on the first failed upload rather than silently skipping ahead.

One script per detected OS handles the whole batch.

### Flow

1. Sanitize; if any names change, preview them and wait for the go-ahead.
2. Detect OS from the workspace folder path.
3. Write the script(s) to the Cowork outputs folder.
4. **`chmod +x` the script(s) before surfacing them.** Every `.command` and `.sh` — skip for `.bat`. Without the executable bit, double-click in Finder fails with *"could not be executed because you do not have appropriate access privileges"*, a different error from Gatekeeper's, and right-click → Open does **not** fix it. Cowork preserves the executable bit through `present_files` to the host filesystem (verified 2026-05-21).
5. Call `mcp__cowork__present_files` with the path(s) so they appear as clickable cards.
6. Tell the user what to do:

   > I've prepared a `.command` upload script. Double-click it to run. (First time, you may need to right-click → Open to bypass macOS's 'unidentified developer' Gatekeeper warning.)
   >
   > (If you're on Linux/Windows instead, let me know and I'll regenerate.)

   When all three were emitted:

   > I've prepared upload scripts for Mac, Linux, and Windows. Double-click the one for your OS. On macOS, first-time runs need right-click → Open to bypass Gatekeeper.

7. **Wait for the user to confirm** ("done", "uploaded", a pasted-back success line). Don't proceed without it.
8. Verify via `cdn_get_stats`.

### After the user reports done

1. `cdn_get_stats({ project: "<project>" })` — for a single file, `file_count` +1 and `total_size_bytes` + the file's size. For a batch, both deltas match the sources.
2. (Single file, optional) `cdn_get_file({ project, name })` to confirm metadata and content-type.
3. Print:

   ```
   ✅ Uploaded — https://cdn.22d.app/<project>/<name>
   ```

   For batches, list URLs (or a tight summary) and totals:

   ```
   ✅ Uploaded 17 files to cdn.22d.app/decks/
      Project totals: 23 files, 142 MB.
   ```

**Verification depth for batches:** the stats delta is sufficient. Don't `cdn_get_file` every file — that's wasted round-trips. Per-file checks are only worth it if the delta looks off.

### If the CLI isn't installed

Don't try to detect this in advance — the CLI lives on the *host*, not in the sandbox, so any `which cdn` probe from the sandbox always fails. Assume it's installed; if the user's Terminal reports `cdn: command not found`, walk them through the one-time install, then have them re-run the same script:

> Looks like the `cdn` CLI isn't installed yet. One-time install:
>
> ```bash
> gh release download v0.1.0 --repo code22d/cdn-cli --pattern "*.tgz" --dir /tmp \
>   && npm install -g /tmp/22d-cdn-cli-0.1.0.tgz
> ```
>
> Then set up the CLI config (`cdn config set r2.accessKeyId <…>` / `cdn config set r2.secretAccessKey <…>` / `cdn config set mcp.token <…>` — see the cdn-cli README for the values). Once that's done, double-click the upload script again.

### What the skill does *not* do for Path E

- Don't try to run the `cdn` command from the sandbox. The CLI is installed on the user's host, not in Cowork. (This is separate from the zero-click path, which uses plain `curl`, not the CLI.)
- Don't try to detect whether the CLI is installed before generating the script.
- **DO `chmod +x`** before `present_files` (`.command`/`.sh` only).
- Don't ask the user what OS they're on.
- Don't embed `MCP_AUTH_TOKEN` or any other secret in the script. The CLI reads credentials from its own config on the host; the verification step is an unauthenticated HEAD to a public URL.
- Don't pre-print a copy-paste `cdn upload …` command. The clickable script is the only Path E output.

## Optional: image compression (only when user asks)

If the user explicitly asks to compress images before upload ("compress these first", "web-optimize", "make them smaller"), use Pillow in the sandbox, then upload the outputs by the normal adaptive flow. Don't auto-route to compression for large images — originals are preserved by default, which is almost always what the user wants.

```bash
# 1. Ensure Pillow is installed (idempotent).
pip install --break-system-packages Pillow >/dev/null 2>&1

# 2. Compress.
python3 - <<'PY'
from PIL import Image
import os

src_dir = "<source folder>"
out_dir = "/tmp/cdn-compressed"
os.makedirs(out_dir, exist_ok=True)

for fname in sorted(os.listdir(src_dir)):
    if not fname.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
        continue
    img = Image.open(os.path.join(src_dir, fname))
    if img.mode in ("RGBA", "P", "LA"):
        img = img.convert("RGB")
    w, h = img.size
    if w > 1920:
        img = img.resize((1920, int(h * 1920 / w)), Image.LANCZOS)
    out_name = os.path.splitext(fname)[0] + ".jpg"
    img.save(os.path.join(out_dir, out_name), "JPEG", quality=85, optimize=True)
    print(f"{fname} -> {out_name} ({os.path.getsize(os.path.join(out_dir, out_name))/1024:.0f} KB)")
PY
```

Compressed outputs land in the sandbox, so they're readable by the **zero-click** path directly. If you end up on **Path E** instead, copy them to a host-mounted folder first (e.g. `~/decks/Q2-pitch-web/`) — the CLI runs on the host and won't see sandbox `/tmp` paths. After uploading, mention:

> Uploaded as JPEG at 1920px width, quality 85. Originals at `<source>` are unchanged.

The user controls whether to delete originals — never auto-delete.

## Error handling

| Symptom | What's likely happening | What to do |
| --- | --- | --- |
| Probe returns `X-Proxy-Error: blocked-by-allowlist` or times out | Sandbox has no egress this session | Go to Path E. Optionally mention the allowlist hosts so the *next* session can go zero-click. |
| Probe passes but `curl PUT` fails with a network error | `cdn.22d.app` is allowlisted, the R2 endpoint isn't | Fall back to Path E. Tell the user the R2 host (`<account>.r2.cloudflarestorage.com`) also needs allowlisting for zero-click. |
| PUT returns 403 `SignatureDoesNotMatch` | A `required_headers` entry was omitted or altered | Re-send with **every** header from `required_headers` byte-identical — most often the missing one is `Cache-Control`. |
| PUT returns 403 after >15 minutes | Presign expired | Mint a fresh `cdn_signed_upload_url` and PUT again. |
| `cdn_signed_upload_url` returns `file_exists` | Target name is taken | Ask whether to overwrite; on yes, re-call with `replace: true`. |
| `cdn_finalize_upload` errors on size mismatch | `size_bytes` didn't match the R2 object | Re-measure the source file and finalize again. Don't guess the size. |
| HEAD verify fails right after finalize | Edge propagation delay, or a name mismatch between PUT and verify | Retry the HEAD once after a moment; if it still fails, check `cdn_list_files` for the actual stored name. |
| `curl -T` fails: no such file | Source isn't sandbox-readable | This is the Path E trigger — switch branches (don't ask the user to re-path it unless they want to mount the folder). |
| User reports `cdn: command not found` after double-clicking | CLI not installed | Print the one-time install command, then have them re-run the same script. |
| User reports `cdn` errors with `missing required config` | CLI installed but config not set up | `cdn config set r2.accessKeyId <…>` / `r2.secretAccessKey` / `mcp.token`. Point at the cdn-cli README. |
| `.command` double-click does nothing, or "appropriate access privileges" | Script wasn't `chmod +x`'d, or macOS Quarantine | `chmod +x` and re-present. For Gatekeeper, suggest right-click → Open. |
| `cdn_get_stats` shows a smaller delta than expected | Some files in the batch didn't upload | Re-run the script — `cdn upload-dir --replace` is idempotent. Don't re-upload everything by hand. |

## What this skill should NOT do

- **Don't replace `cdn_help`.** That's the explainer tool. This is the executor.
- **Don't fire on uploads to other systems** — Slack, Drive, Notion, GitHub, S3, Dropbox, iCloud. The trigger is specifically the personal CDN at `cdn.22d.app` / the `cdn-mcp` connector.
- **Don't invoke `cdn_upload_file`** — see *What NOT to do*. It hard-rejects external callers as of Worker Phase 11.3.
- **Don't auto-detect the CLI** via `which cdn` or any other sandbox probe. The CLI runs on the host; sandbox detection always fails.
- **Don't upload an unsafe filename silently.** Show the sanitized name and let the user override.
- **Don't auto-route to compression** for large images. Compression is opt-in only.
- **Don't auto-delete originals after compression.** The user owns that decision.
- **Don't run uploads without confirming the project.** A wrong project name creates wrong URLs and cleanup is annoying.
- **Don't assume the sandbox can or can't reach the network.** Probe. Earlier versions of this skill asserted a blanket "the sandbox proxy 403s all outbound HTTPS" — that is no longer true when the user has allowlisted the CDN hosts, and it's exactly what the probe is for.

## Sample interactions

### Sample A — zero-click (probe passes, file in a mounted folder)

User: *"Upload `~/Documents/Claude/Projects/decks/q2-hero.png` to project `decks`"*

You:
1. Probe: `curl -sI --max-time 10 https://cdn.22d.app/` → `HTTP/2 200`, `server: cloudflare`. Egress OK.
2. `ls -l` the source — readable from the sandbox. ✓
3. Basename `q2-hero.png` is clean — no preview needed.
4. `cdn_signed_upload_url({project: "decks", name: "q2-hero.png", content_type: "image/png"})` → `upload_url` + `required_headers` (`Content-Type`, `Cache-Control: public, max-age=60`).
5. `curl -sS --max-time 60 -X PUT -T "<path>" -H "Content-Type: image/png" -H "Cache-Control: public, max-age=60" "<upload_url>"` → 200, ETag captured.
6. `cdn_finalize_upload({project: "decks", name: "q2-hero.png", content_type: "image/png", size_bytes: 412334})`.
7. `curl -sIf https://cdn.22d.app/decks/q2-hero.png` → 200.
8. *"✅ Uploaded — https://cdn.22d.app/decks/q2-hero.png"*

No script, no double-click, no user step after step 3.

### Sample B — probe fails → Path E

User: *"Upload `~/videos/q2-demo.mp4` (180 MB) to project `videos`"*

You:
1. Probe → `curl: (28) Operation timed out`. No egress this session.
2. Basename is clean. Detect OS from the workspace path (`/Users/rene/…` → macOS).
3. Write `upload-q2-demo.mp4.command` with `cdn upload "videos" "/Users/rene/videos/q2-demo.mp4"`, `chmod +x`, `present_files`.
4. *"I've prepared a `.command` upload script. Double-click to run — it'll upload and verify. On Mac, first time, right-click → Open to bypass Gatekeeper."* (Optionally: *"If you allowlist `cdn.22d.app` and the R2 endpoint in Cowork's settings, future sessions can upload without the script.")*
5. User: *"done"* → `cdn_get_stats({project: "videos"})` → confirm +1 file, +180 MB.
6. *"✅ Uploaded — https://cdn.22d.app/videos/q2-demo.mp4"*

### Sample C — probe passes, but the PUT host is blocked

User: *"Upload `~/Documents/Claude/Projects/blog/hero.png` to `blog`"*

You:
1. Probe `cdn.22d.app` → 200. Egress looks OK.
2. Source is readable. Mint the signed URL.
3. `curl PUT` to `1ca89091….r2.cloudflarestorage.com` → `curl: (56) CONNECT tunnel failed`. The R2 host isn't allowlisted.
4. **Fall back to Path E** — no retries, no base64. Generate `upload-hero.png.command`, `chmod +x`, present.
5. Mention: *"Zero-click needs the R2 endpoint allowlisted too (`1ca89091477fe859962f0e9a14e8942e.r2.cloudflarestorage.com`). Add it in Cowork settings and new sessions will skip the script."*
6. The abandoned presign is harmless — no D1 row was written.

### Sample D — file outside the sandbox

User: *"Upload `/tmp/screenshot.png` to `blog`"* (nothing mounted at `/tmp`)

You:
1. Probe → 200. Egress fine.
2. `ls -l /tmp/screenshot.png` → no such file. The sandbox can't see it.
3. **Path E anyway** — egress doesn't help if there are no bytes to send. Generate the script pointing at the host path `/tmp/screenshot.png`, which the *host's* CLI can read.
4. `chmod +x`, present, wait for "done", verify with `cdn_get_stats`.

### Sample E — unsafe name (sanitization preview)

User: *"Upload `~/Desktop/Q3 Report (FINAL).pdf` to project `proposals`"*

You:
1. Basename has spaces and parens → propose `Q3_Report__FINAL_.pdf`. Show the preview.
2. User: *"call it q3-report-final.pdf"* — validate (clean) and use it.
3. Probe, then branch as usual. On zero-click, `name` = `q3-report-final.pdf` in both the presign and finalize. On Path E, the `cdn upload` line keeps the original source path quoted and adds `--name "q3-report-final.pdf"`.
4. Verify → *"✅ Uploaded — https://cdn.22d.app/proposals/q3-report-final.pdf"*

### Sample F — user asks for base64

User: *"It's a small file, just base64 it through `cdn_upload_file`."*

You: decline, briefly, and do the right thing:

> `cdn_upload_file` hard-rejects external calls (Worker Phase 11.3) — base64-over-MCP isn't a path anymore. I'll run the normal flow instead: probe egress, then either upload it directly (zero-click) or hand you a one-double-click script. Same result, and it verifies the public URL at the end.

Then probe and proceed. This is the one case where the skill overrides a direct user instruction — say so plainly rather than silently ignoring the ask.

## References

- The cdn-cli's README at `~/Documents/Claude/Local Folder/cdn-cli/README.md` documents the canonical `cdn upload` / `cdn upload-dir` flags and config setup.
- The original 5-path design rationale lives in `~/Documents/Claude/Projects/CDN w MCP/cdn_file_upload_skill_design.md` — historical context only; the adaptive routing above supersedes it.

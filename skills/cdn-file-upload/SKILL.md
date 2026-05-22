---
name: cdn-file-upload
description: Upload files of any size or type to Rene's personal CDN at cdn.22d.app via the cdn-mcp connector. Use whenever the user wants to host, upload, or publish files on the CDN — phrases like "upload to cdn.22d.app", "host on the CDN", "put these on the CDN", "host this image/video/asset/deck", or any request to make local files publicly reachable through cdn.22d.app. For files larger than ~1 MB the skill prints a `cdn upload` command for the user's terminal (via the local cdn-cli); trivially small files upload directly through the MCP. A signed-URL `.command` script is the fallback when the CLI isn't installed. Prefer this skill over ad-hoc base64 uploads — its routing handles the "MCP payload too big" failures on files larger than ~3 MB. Do NOT fire when the user means uploads to other systems (GitHub, Slack, Drive, Notion, S3, Dropbox, iCloud, etc.) — only when the destination is cdn.22d.app or the cdn-mcp connector.
---

# cdn-file-upload

Upload single files or batches of any size or type to the personal CDN at `cdn.22d.app` via the `cdn-mcp` connector. The skill's job is to pick the right transport, generate the exact command (or call), and verify after.

The companion `cdn_help` MCP tool documents the CDN architecture if you need orientation. This skill is for *executing* uploads, not explaining them.

## Why this skill exists

The CDN has two execution surfaces, and the right one depends almost entirely on file size:

- **The local CLI (`cdn`, installed on the user's host machine)** is the canonical upload tool for anything that isn't trivially small. It streams bytes from disk straight to R2 with no payload caps and no sandbox in the middle, then finalizes metadata via the Worker. The skill's primary job for non-trivial uploads is to figure out *what* the user wants to upload, write a clickable upload script targeting the user's OS, and verify the result after they double-click it.
- **The MCP layer's `cdn_upload_file`** is a base64 round-trip — clean and zero-friction for files ≤ 1 MB, but it fails on anything larger because the JSON-RPC payload cap fires. Use it only when the file is small enough that round-tripping through the user's terminal would be unnecessary friction.

A third path — a signed-URL `.command` script the user double-clicks — exists as the **day-1 fallback for users who don't have the CLI installed yet**. It's not the default for large files anymore; it's the safety net when `cdn: command not found` comes back from the user's terminal.

Historical note: earlier versions of this skill had a 5-path decision tree (A/B/C/D/E) that tried to auto-detect the CLI via `which cdn` in the sandbox. The CLI lives on the *host*, not in the sandbox, so detection always failed and every non-trivial upload silently fell through to the `.command`-file path. This rewrite eliminates the detection step and assumes the CLI is installed; if it isn't, the user's terminal surfaces a clear "command not found" and the skill switches to the fallback then.

## Pre-flight checks (do these first, every time)

Before doing anything, verify:

1. **The cdn-mcp connector is reachable.** Tools like `cdn_upload_file`, `cdn_signed_upload_url`, `cdn_finalize_upload`, `cdn_get_stats` should appear in the available tools. If they don't, tell the user: *"The cdn-mcp connector isn't configured in this session. Add it via claude.ai → Settings → Customize → Connectors. Run `cdn_help` once it's connected for the URL pattern."* Then stop.
2. **The user has specified what to upload.** A file path, a directory, or attached files. If unclear, ask before guessing.
3. **The user has specified a target project.** The project is the first path segment in the public URL (`cdn.22d.app/<project>/<filename>`). If not specified, ask: *"Which CDN project should I upload to? (e.g., `blog`, `videos`, `proposals`, `decks`)"* Project names match `^[a-zA-Z0-9_-]+$`, max 64 chars — no dots, no spaces.

## Decision tree

For each upload (single file or batch):

1. **Get the file size.** In the sandbox: `stat -c%s <file>` (Linux). Sum sizes for a batch.

2. **Resolve the local file path to an absolute path.** If the user said `~/decks/q2.png`, expand `~` and any relative segments before printing any `cdn` command. The user's terminal `cwd` is not necessarily the sandbox `cwd`, so a copy-pasted relative path can land in the wrong place. Always print absolute paths in Path E commands.

3. **Pick the path:**

   - **File size ≤ 1 MB AND batch size ≤ 10 files** → **Path A** (direct base64 via MCP `cdn_upload_file`). No CLI needed; works for any user including partners who haven't installed the CLI.
   - **Anything else** (any single file > 1 MB, or batch > 10 files) → **Path E** (clickable script invokes the CLI on the user's host). Default path for non-trivial uploads.
   - **Path C (signed URL + `.command` file)** is the **fallback** for users without the CLI installed. Only switch to Path C if:
     - The user explicitly says "I don't have the CLI" / "use the script approach" / similar, **or**
     - The user runs the `cdn upload …` command from Path E and reports back `command not found` (or any clear "CLI not installed" signal).

   When falling back to Path C, also tell the user how to install the CLI so the next upload is friction-free:

   ```bash
   gh release download v0.1.0 --repo code22d/cdn-cli --pattern "*.tgz" --dir /tmp \
     && npm install -g /tmp/22d-cdn-cli-0.1.0.tgz
   ```

   Then continue with Path C for the current upload.

**Compression is opt-in, not auto-routed.** If the user explicitly asks to compress images first ("compress these to JPEGs", "web-optimize first", etc.), use the compression recipe in the *Optional: image compression* section below before uploading. Otherwise Path E preserves the original bytes regardless of size — videos, large images, design assets all go through unchanged.

## Path A — Direct base64 (≤ 1 MB single file, or ≤ 10 small files)

For files small enough to fit comfortably through the MCP.

```
For each file:
  bytes  = read <file> from disk
  b64    = base64-encode(bytes)
  result = cdn_upload_file(
             project=<proj>,
             name=<basename or sub/path/name>,
             content_base64=b64,
             content_type=<inferred from extension>,
           )
  print result.url
```

`cdn_upload_file` infers Content-Type from the extension server-side, so you don't need to pass `content_type` — but you can if you want to override (e.g., serving `.html` as `text/plain`). The `name` parameter accepts forward slashes (e.g. `2026-05/hero.png`) for sub-path organization within a project, but no leading slash, no leading dot, no `..` segments.

## Path E — Clickable upload script (default for anything that isn't trivially small)

The skill writes a small double-clickable script that runs the `cdn` CLI on the user's host. The user opens the script from Finder/Explorer; their Terminal runs `cdn upload` (which streams bytes from disk to R2 with no payload caps) and then HEAD-checks the public URL to confirm the file is live. The skill verifies via `cdn_get_stats` after the user reports back.

This replaces the older "print a copy-paste `cdn upload` command" UX. The script is friendlier for partners who aren't terminal-native and includes an automatic post-upload verification step.

### OS detection

Inspect the user's workspace folder path (the absolute path of the mounted folder Cowork is operating in — visible in the session env / shown as the user's selected folder):

- Starts with `/Users/` → **macOS** → emit `.command`
- Starts with `/home/` → **Linux** → emit `.sh`
- Contains a backslash, or matches `^[A-Za-z]:` (drive letter) → **Windows** → emit `.bat`
- Anything else / ambiguous → emit **all three** as a safe fallback

Never ask the user what OS they're on — the workspace path is reliable, and if it isn't, emitting all three is the cheap default (the scripts are ~500 bytes each).

### Script naming

- Single file: `upload-<sanitized-source-filename>.<ext>` (e.g., `upload-q2-demo.mp4.command`).
- Batch: `upload-<project>-batch.<ext>` (e.g., `upload-decks-batch.command`).
- Sanitization applies to the **script's filename only**: replace `[^A-Za-z0-9._-]` with `_`. The `cdn upload` invocation **inside** the script always uses the original absolute path, double-quoted, so spaces and Unicode in the source filename are preserved.

### Script templates

`.command` (macOS) and `.sh` (Linux) are identical bash:

```bash
#!/bin/bash
# Auto-generated by cdn-file-upload skill.
# Uploads <filename> to project <project> on cdn.22d.app.

set -e
export PATH="$HOME/.npm-global/bin:$PATH"

echo "Uploading <filename> to project <project>…"
echo ""

cdn upload "<project>" "<absolute-path-to-file>"

echo ""
echo "Verifying file is live…"
if curl -sIf -o /dev/null "https://cdn.22d.app/<project>/<filename>"; then
  echo "✓ Verified: https://cdn.22d.app/<project>/<filename>"
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

cdn upload "<project>" "<absolute-path-to-file>"
if errorlevel 1 (
  echo.
  echo Upload failed. See error above.
  pause
  exit /b 1
)

echo.
echo Verifying file is live...
curl -sIf -o nul "https://cdn.22d.app/<project>/<filename>"
if errorlevel 1 (
  echo Upload reported success but verification failed. File may take a moment to propagate.
  echo Check: cdn list ^<project^>
) else (
  echo Verified: https://cdn.22d.app/<project>/<filename>
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

`cdn upload` accepts the same flags as before — add them to the script's `cdn upload …` line when the user's intent is clear:

- `--name <sub/path/file.ext>` to organize under a sub-path within the project.
- `--replace` if overwriting an existing file at the same name.

`cdn upload-dir` (used for directory batches — see below) accepts `--prefix`, `--include`/`--exclude` globs, `--concurrency`, and `--replace`.

### Batches

For multi-file batches:

- **Source is a directory** → use a single `cdn upload-dir "<project>" "<absolute-dir-path>"` line. For directories, skip per-file `curl` verification in the script and rely on `cdn_get_stats` after — the stats delta is the canonical check.
- **Source is a list of discrete files** → multiple `cdn upload` lines back-to-back, then a loop of `curl -sIf` checks (one per public URL). `set -e` ensures the script halts on the first failed upload rather than silently skipping ahead.

One script per detected OS handles the whole batch.

### Flow

1. Detect OS from the user's workspace folder path.
2. Write the script(s) to the Cowork outputs folder, using the naming + sanitization rules above.
3. **`chmod +x` the script(s) before surfacing them.** Run `chmod +x <script-path>` via the bash tool for every `.command` (macOS) and `.sh` (Linux) file you just wrote. Skip for `.bat` (Windows runs cmd scripts regardless of POSIX perms). Without the executable bit, double-click in Finder fails with *"could not be executed because you do not have appropriate access privileges"* — a different error from Gatekeeper, and right-click → Open does not fix it. Cowork preserves the executable bit through `present_files` to the host filesystem (verified 2026-05-21).
4. Call `mcp__cowork__present_files` with the file path(s) so they appear as clickable cards in chat.
5. Tell the user what to do. Suggested phrasing when a single OS was detected:

   > I've prepared a `.command` upload script. Double-click it to run. (First time, you may need to right-click → Open to bypass macOS's 'unidentified developer' Gatekeeper warning.)
   >
   > (If you're on Linux/Windows instead, let me know and I'll regenerate.)

   When detection was ambiguous and all three were emitted:

   > I've prepared upload scripts for Mac, Linux, and Windows. Double-click the one for your OS. On macOS, first-time runs need right-click → Open to bypass Gatekeeper.

6. **Wait for the user to confirm** completion ("done", "uploaded", "finished", or a pasted-back success line). Don't proceed without confirmation.
7. Verify via `cdn_get_stats` (see *After the user reports done* below).

### After the user reports done

1. Call `cdn_get_stats({ project: "<project>" })` to verify the upload landed. For a single file, `file_count` should increment by 1 and `total_size_bytes` by the file's size. For a batch, both deltas should match the sources.
2. (Single file only, optional) Call `cdn_get_file({ project, name })` to confirm metadata and content-type.
3. Print:

   ```
   ✅ Uploaded — https://cdn.22d.app/<project>/<name>
   ```

   For batches, list URLs (or a tight summary) and totals:

   ```
   ✅ Uploaded 17 files to cdn.22d.app/decks/
      Project totals: 23 files, 142 MB.
   ```

**Verification depth for batches:** the stats delta is sufficient. Don't `cdn_get_file` every file in the batch — that's wasted round-trips. Per-file metadata checks are only worth doing if the stats delta looks off.

### What the skill does *not* do for Path E

- Don't try to run the `cdn` command yourself from inside the sandbox. The CLI is installed on the user's host, not in Cowork. The script runs on the host; the skill verifies after.
- Don't try to detect whether the CLI is installed before suggesting Path E. Assume it is. If the script's Terminal output reports `cdn: command not found`, switch to Path C with install instructions.
- **DO `chmod +x` the script before `present_files`** (for `.command` and `.sh` only — `.bat` doesn't need it). Cowork preserves the executable bit through Save to the host filesystem (verified 2026-05-21). Without it, double-click in Finder fails with *"could not be executed because you do not have appropriate access privileges"*, and right-click → Open does NOT fix that error — it only bypasses Gatekeeper's first-run "unidentified developer" warning, which is a separate issue.
- Don't ask the user what OS they're on. The workspace folder path is reliable; fall back to emitting all three if it's ambiguous.
- Don't embed `MCP_AUTH_TOKEN` or any other secret in the script. The CLI reads credentials from `~/.config/cdn-cli/` on the host; the verification step is an unauthenticated HEAD request to a public URL.
- Don't pre-print a copy-paste `cdn upload …` command. The clickable script is the only Path E output.

## Path C — Signed URL + `.command` file (fallback when CLI is not installed)

For users who haven't installed the `cdn` CLI yet. The skill writes a double-clickable `.command` shell script to a mounted folder; the user double-clicks it; macOS opens Terminal and runs `curl` against the signed URLs. Bypasses both the MCP payload cap and the sandbox's curl block — the user's native machine has full network access.

**When to use this path:**

- The user explicitly says they don't have the CLI installed, or asks for the script approach.
- The user ran a `cdn upload …` command from Path E and reported `command not found`.
- (Edge case) The CLI is installed but the user prefers the `.command` flow for some specific upload — defer to their preference.

When falling into this path, **first** print the CLI install command so the next upload doesn't repeat the workaround:

> Looks like the `cdn` CLI isn't installed. I'll fall back to a `.command` script for this upload. To skip this step next time, install the CLI:
>
> ```bash
> gh release download v0.1.0 --repo code22d/cdn-cli --pattern "*.tgz" --dir /tmp \
>   && npm install -g /tmp/22d-cdn-cli-0.1.0.tgz
> ```
>
> Then set up `~/.cdn-cli/config.json` (see the cdn-cli README). Future uploads will go straight through without the double-click step.

Then continue with the flow below.

### Flow

1. **For each file**, call `cdn_signed_upload_url(project=<proj>, name=<name>, content_type=<inferred>)`. Save:
   - `upload_url` — the presigned PUT URL (~15-min expiry by default; check the response)
   - `required_headers` — typically just `Content-Type` (signed into the URL via SigV4)
   - The eventual public URL after finalize
2. **Write `upload-batch.command`** to `~/Documents/Claude/Projects/CDN w MCP/uploads/`. Create the directory if it doesn't exist. Use the template below.
3. **`chmod +x`** the script — required for double-click on macOS.
4. **Tell the user** plainly what to do. Suggested phrasing:

   > I've written `upload-batch.command` to `~/Documents/Claude/Projects/CDN w MCP/uploads/`. Double-click it in Finder — Terminal will open, the script will upload all N files via curl, and prompt you to close the window when done. Come back and tell me "done" once it finishes.

5. **Wait for the user to confirm** ("done", "finished", "uploaded", etc.). Do not proceed without confirmation — finalizing before the bytes are in R2 corrupts the metadata.
6. **For each file**, call `cdn_finalize_upload(project=<proj>, name=<name>, content_type=<inferred>, size_bytes=<size>)`. This writes the D1 metadata row that makes the file appear in `cdn_list_files` and in the public URL routing.
7. **Verify** with `cdn_get_stats()` — confirm the new `file_count` and `total_size_bytes` line up with what you uploaded.
8. **Optionally** delete the `.command` script. Rene tends to leave them around to inspect; ask before cleaning up unless he's said "clean up after yourself".

### `.command` file template

```bash
#!/bin/bash
# upload-batch.command — generated by cdn-file-upload skill
# Generated: <ISO timestamp>
# Source:    <absolute path of source folder>
# Target:    cdn.22d.app/<project>/
# Files:     <count>

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

cd "<absolute path to source folder>"

echo "Uploading <N> files to cdn.22d.app/<project>/..."
echo ""

# One curl per file — set -e exits on first failure so we don't
# silently half-upload.
curl -fsS -X PUT \
  -H "Content-Type: <content-type-1>" \
  -H "Cache-Control: public, max-age=60" \
  --data-binary @<filename-1> \
  "<signed-url-1>" \
  && echo -e "${GREEN}✓${NC} <filename-1>" \
  || { echo -e "${RED}✗${NC} <filename-1>"; exit 1; }

# ... repeat for each file ...

echo ""
echo -e "${GREEN}All <N> uploads complete.${NC}"
echo "Switch back to Cowork and tell Claude 'done' to finalize metadata."
echo ""
read -p "Press Enter to close this window..."
```

Notes on the template:

- `Cache-Control: public, max-age=60` matches the MCP's `DEFAULT_CACHE_CONTROL` constant. Always include it — without it, R2 returns no header and Cloudflare's edge caches hold stale bytes >30 s after a replace.
- The `set -e` plus the `||` clause is belt-and-suspenders: even if a curl fails, the user gets a clear red ✗ on the failing file before the script exits.
- The `read -p` at the end keeps the Terminal window open so the user can see the output.
- Use `--data-binary @<file>` not `-d @<file>` — the former preserves bytes exactly; the latter strips newlines.

### Why `.command` and not `.sh`

macOS treats `.command` files as double-clickable shell scripts that open in Terminal. A `.sh` file opens in the default text editor instead. The user's flow is "double-click in Finder, watch it run, tell Claude done" — `.command` makes that work without typing anything into Terminal.

## Optional: image compression (only when user asks)

If the user explicitly asks to compress images before upload ("compress these first", "web-optimize", "make them smaller"), use Pillow in the sandbox, then upload the compressed outputs via Path E or Path A. Don't auto-route to compression for large images — Path E preserves originals by default, which is almost always what the user wants.

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

Then upload from `/tmp/cdn-compressed/` via Path E (the directory is now in the sandbox; pass `/tmp/cdn-compressed` to `cdn upload-dir` — but note the CLI runs on the host and won't see sandbox `/tmp` paths; copy the compressed outputs to a mounted folder first, or use Path A if everything's now ≤ 1 MB). After uploading, mention:

> Uploaded as JPEG at 1920px width, quality 85. Originals at `<source>` are unchanged.

The user controls whether to delete originals — never auto-delete.

## Validation after upload

After every successful upload (any path):

1. Call `cdn_get_stats()`. Compare new totals to what you uploaded.
2. For batches >5 files via Path C, optionally `curl` 1–2 random files and `sha256sum` against the originals to verify byte integrity. (For Path C this catches a wrong Content-Type header signed into the URL, which would let the PUT succeed but serve corrupt bytes.) For Path E, the CLI handles content-type itself, so this check is rarely worth it.
3. Print a clean summary:

   ```
   ✓ Uploaded 17 files to cdn.22d.app/decks/

     slide-01.png  →  https://cdn.22d.app/decks/slide-01.png   (412 KB)
     slide-02.png  →  https://cdn.22d.app/decks/slide-02.png   (387 KB)
     ...

   Project totals: 17 files, 6.8 MB.
   ```

   Keep it tight — Rene reads these summaries quickly. List the URLs (he'll want to copy them) but skip the chatty preamble.

## Error handling

| Symptom | What's likely happening | What to do |
| --- | --- | --- |
| `cdn_upload_file` errors with payload size | File > ~1 MB; you picked Path A for something that should be Path E | Switch to Path E. Print the `cdn upload …` command and ask the user to run it. |
| User reports `cdn: command not found` after Path E | CLI not installed | Fall back to Path C and print the install command. Don't retry Path E. |
| User reports `cdn` errors with `missing required config` | CLI installed but `~/.cdn-cli/config.json` not set up | Tell the user to run `cdn config set r2.accessKeyId <…>` / `cdn config set r2.secretAccessKey <…>` / `cdn config set mcp.token <…>` (the three required fields). Point at cdn-cli README for the values. |
| User reports `cdn` errors with `file_exists` | Target already exists; CLI guards against accidental overwrites | Ask the user whether to overwrite. If yes, regenerate the command with `--replace` appended. |
| File doesn't exist when you `stat` it | Probably a typo, or the file is outside mounted folders | List the missing files and ask the user to clarify or mount the parent folder. |
| Sandbox bash can't read the file (permission denied) | File is on a non-mounted volume | Ask the user to mount the parent folder via Cowork's folder picker. |
| `.command` double-click does nothing (Path C) | macOS Quarantine, or the script wasn't `chmod +x`'d | Suggest right-click → Open, or `chmod +x <file>.command` from Terminal. |
| `curl` PUT fails inside `.command` (Path C) | Likely an expired signed URL (>15 min between generation and double-click) or wrong Content-Type | Regenerate signed URLs (small batch — fast), rewrite the script. |
| Finalize fails after PUT succeeded (Path C) | Bytes are in R2; the D1 row is missing | Retry `cdn_finalize_upload`. If it still fails, the bytes are still served at the public URL — tell the user, and check `cdn_list_files` to see whether the metadata caught up. |
| `cdn_get_stats` shows a smaller delta than expected | Some files in the batch didn't upload | For Path E: ask the user to re-run `cdn upload-dir` with `--replace` (idempotent — re-uploads missing files, skips existing). For Path C: re-run only the missing files via a fresh `.command`. Don't re-upload everything. |

## What this skill should NOT do

- **Don't replace `cdn_help`.** That's the explainer tool. This is the executor.
- **Don't fire on uploads to other systems** — Slack, Drive, Notion, GitHub, S3, Dropbox, iCloud. The trigger is specifically the personal CDN at `cdn.22d.app` / the `cdn-mcp` connector.
- **Don't auto-detect the CLI** via `which cdn` or any other sandbox probe. The CLI runs on the host; sandbox detection always fails. Assume installed; let the user's terminal surface the truth.
- **Don't auto-route to compression** for large images. Compression is opt-in only.
- **Don't auto-delete originals after compression.** The user owns that decision.
- **Don't run uploads without confirming the project.** A wrong project name creates wrong URLs and cleanup is annoying.
- **Don't write a `.command` script unless Path C is the chosen path.** Path E doesn't need one — the user runs the `cdn` command directly.
- **Don't `curl` from the sandbox** trying to bypass the MCP. The sandbox proxy returns 403 on outbound HTTPS. Path C's `.command` runs on the *user's* machine, where curl works.

## Sample interactions

### Sample A — single small file (Path A)

User: *"Upload `~/blog/hero.png` (412 KB) to project `blog`"*

You:
1. `stat`: 412 KB → Path A.
2. Read + base64 + `cdn_upload_file({project: "blog", name: "hero.png", content_base64: …})`.
3. *"✅ Uploaded — https://cdn.22d.app/blog/hero.png (412 KB)"*

### Sample B — single large file (Path E)

User: *"Upload `~/videos/q2-demo.mp4` (180 MB) to project `videos`"*

You:
1. `stat`: 180 MB → Path E (way over 1 MB).
2. Detect OS from the workspace path (`/Users/rene/…` → macOS).
3. Write `upload-q2-demo.mp4.command` to the Cowork outputs folder using the bash template — filled in with project `videos`, absolute path `/Users/rene/videos/q2-demo.mp4`, filename `q2-demo.mp4`.
4. Call `mcp__cowork__present_files` with that one file.
5. Tell the user: *"I've prepared a `.command` upload script. Double-click to run — it'll upload and verify. On Mac, first time, right-click → Open to bypass Gatekeeper."*
6. User: *"done"*.
7. `cdn_get_stats({project: "videos"})` → confirm file_count +1, total_size_bytes +180 MB.
8. *"✅ Uploaded — https://cdn.22d.app/videos/q2-demo.mp4"*

### Sample C — directory batch (Path E)

User: *"Upload all 17 deck images from `~/decks/Q2-pitch/` to project `decks`"*

You:
1. List: 17 PNGs, 6–8 MB each → Path E (any single file > 1 MB).
2. Detect OS (`/Users/rene/…` → macOS).
3. Write `upload-decks-batch.command` to outputs — single `cdn upload-dir "decks" "/Users/rene/decks/Q2-pitch"` line in the script. Skip per-file `curl` verification for directories; rely on `cdn_get_stats` after.
4. Call `mcp__cowork__present_files` with the script.
5. Tell user: *"I've prepared `upload-decks-batch.command`. Double-click to run."* + Gatekeeper note.
6. User: *"done"*.
7. `cdn_get_stats({project: "decks"})` → confirm file_count +17 and size delta matches.
8. Print summary + a few sample URLs.

### Sample D — CLI not installed (Path C fallback)

User: *"Upload `~/videos/q2-demo.mp4` (180 MB) to project `videos`"*

You: (steps 1–2 above)

User: *"the Terminal said `zsh: command not found: cdn`"*

You:
1. Acknowledge: *"Looks like the `cdn` CLI isn't installed. Falling back to a signed-URL script for this upload. To skip this next time, install the CLI:"* + install command.
2. `cdn_signed_upload_url({project: "videos", name: "q2-demo.mp4", content_type: "video/mp4"})` → presigned URL.
3. Write `upload-q2-demo.command` (single curl PUT) to `~/Documents/Claude/Projects/CDN w MCP/uploads/`, `chmod +x`.
4. *"Double-click `upload-q2-demo.command`. Will take 30–60 sec depending on your connection. Tell me when done."*
5. User: *"done"*.
6. `cdn_finalize_upload({project: "videos", name: "q2-demo.mp4", content_type: "video/mp4", size_bytes: …})`.
7. *"✅ Uploaded — https://cdn.22d.app/videos/q2-demo.mp4"*

### Sample E — user wants compression first (opt-in)

User: *"Compress all the PNGs in `~/decks/Q2-pitch/` to web-optimized JPEGs first, then upload to `decks`"*

You:
1. Run the Pillow compression recipe → outputs in `/tmp/cdn-compressed/`.
2. Copy outputs to a host-mounted folder (e.g. `~/decks/Q2-pitch-web/`) so the CLI can see them.
3. Path E: `cdn upload-dir decks /Users/rene/decks/Q2-pitch-web`.
4. Verify + summary, noting the compression settings (1920px, quality 85).

## References

- The cdn-cli's README at `~/Documents/Claude/Local Folder/cdn-cli/README.md` documents the canonical `cdn upload` / `cdn upload-dir` flags and config setup.
- The original 5-path design rationale lives in `~/Documents/Claude/Projects/CDN w MCP/cdn_file_upload_skill_design.md` — kept as historical context. The current routing supersedes it.

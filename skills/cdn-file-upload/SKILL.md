---
name: cdn-file-upload
description: Upload files of any size or type to Rene's personal CDN at cdn.22d.app. Use whenever the user wants to host, upload, or publish files on the CDN — phrases like "upload to cdn.22d.app", "host on the CDN", "put these on the CDN", "host this image/video/asset/deck", or any request to make local files publicly reachable through cdn.22d.app. Every upload goes through a clickable script (.command/.sh/.bat) that runs the local `cdn` CLI on the user's host — no size limits, no base64, no MCP payload caps. The skill auto-sanitizes filenames with spaces or special characters (with user preview) before generating the script, and verifies via the cdn-mcp connector after. Do NOT fire when the user means uploads to other systems (GitHub, Slack, Drive, Notion, S3, Dropbox, iCloud, etc.) — only when the destination is cdn.22d.app or the cdn-mcp connector.
---

# cdn-file-upload

Upload single files or batches of any size or type to the personal CDN at `cdn.22d.app`. The skill's job is to generate a clickable upload script targeting the user's OS, walk the user through running it, and verify the result after.

The companion `cdn_help` MCP tool documents the CDN architecture if you need orientation. This skill is for *executing* uploads, not explaining them.

## Why Path E only

Every upload goes through **Path E**: a double-clickable script that runs the local `cdn` CLI on the user's host. There is no size-based routing anymore. Most real files are larger than 1 MB, so the old small-file base64 path (`cdn_upload_file` over MCP) was optimizing for a rare case while adding a second, inconsistent flavor of "upload happens" (silent base64 vs. clickable script). Path E streams bytes from disk straight to R2 via signed URLs with no payload caps and doesn't depend on the MCP connector being healthy — the connector is still used for metadata and verification (`cdn_get_stats`, `cdn_list_files`, `cdn_get_file`), but never for moving bytes. One path, one user experience, regardless of size.

Historical note: earlier versions had a 5-path decision tree (A/B/C/D/E), then a 3-path tree (A/E/C). Both are gone. The MCP upload tools (`cdn_upload_file`, `cdn_signed_upload_url`, `cdn_finalize_upload`) still exist on the connector and remain available for ad-hoc use, but this skill no longer invokes them.

## Pre-flight checks (do these first, every time)

Before doing anything, verify:

1. **The user has specified what to upload.** A file path, a directory, or attached files. If unclear, ask before guessing.
2. **The user has specified a target project.** The project is the first path segment in the public URL (`cdn.22d.app/<project>/<filename>`). If not specified, ask: *"Which CDN project should I upload to? (e.g., `blog`, `videos`, `proposals`, `decks`)"* Project names match `^[a-zA-Z0-9_-]+$`, max 64 chars — no dots, no spaces.
3. **The cdn-mcp connector is reachable** (tools like `cdn_get_stats`, `cdn_list_files` appear in the available tools). Uploads do NOT depend on the connector — the script talks to R2 directly via the CLI — but post-upload verification does. If the connector is missing, proceed with the upload anyway and tell the user: *"The cdn-mcp connector isn't configured in this session, so I'll rely on the script's own curl verification instead of `cdn_get_stats`. Add the connector via claude.ai → Settings → Connectors when you get a chance."*

## Filename sanitization

Before generating the script, check the **source basename** for characters outside `[a-zA-Z0-9._-]` — spaces, parentheses, brackets, ampersands, hash, percent, unicode glyphs, anything that doesn't URL-encode cleanly.

- **Basename is already clean** → skip this section entirely. No warning, no preview — upload with the original name.
- **Basename contains unsafe characters** → compute the sanitized name by replacing **each** unsafe character with `_`, then show the user the proposed name BEFORE generating the script:

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

Mechanics:

- The `cdn upload` line inside the script gets `--name "<sanitized-name>"`. The CLI already supports `--name`; the **source path argument keeps the original absolute path** (double-quoted), so the file is read from disk as-is and only its CDN name changes.
- The verification `curl` URL and the final public URL use the sanitized name: `https://cdn.22d.app/<project>/<sanitized-name>`.
- For **discrete-file batches**, apply the same check per file — one preview message listing all renames, one confirmation.
- For **directory batches** (`cdn upload-dir`), the CLI keeps original names and `--name` doesn't apply. List the directory first; if any basenames are unsafe, tell the user and upload those files individually with `--name` (clean files still go through `upload-dir`), or suggest renaming the sources.

## Path E — Clickable upload script (the only path)

The skill writes a small double-clickable script that runs the `cdn` CLI on the user's host. The user opens the script from Finder/Explorer; their Terminal runs `cdn upload` (which streams bytes from disk to R2 with no payload caps) and then HEAD-checks the public URL to confirm the file is live. The skill verifies via `cdn_get_stats` after the user reports back.

### Resolve paths first

If the user said `~/decks/q2.png`, expand `~` and any relative segments before writing the script. The user's terminal `cwd` is not necessarily the sandbox `cwd`, so a relative path can land in the wrong place. Always embed absolute paths in the script.

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
- The script's own filename always uses the sanitized form (replace `[^A-Za-z0-9._-]` with `_`) — same rule as upload-name sanitization above.

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

`cdn upload` accepts the same flags as before — add them to the script's `cdn upload …` line when the user's intent is clear:

- `--name <sub/path/file.ext>` to set the CDN-side name — used for sanitization (above) and for organizing under a sub-path within the project. Accepts forward slashes (e.g. `2026-05/hero.png`), but no leading slash, no leading dot, no `..` segments.
- `--replace` if overwriting an existing file at the same name.

`cdn upload-dir` (used for directory batches — see below) accepts `--prefix`, `--include`/`--exclude` globs, `--concurrency`, and `--replace`.

### Batches

For multi-file batches:

- **Source is a directory** → use a single `cdn upload-dir "<project>" "<absolute-dir-path>"` line. For directories, skip per-file `curl` verification in the script and rely on `cdn_get_stats` after — the stats delta is the canonical check. (Check for unsafe basenames first — see *Filename sanitization*.)
- **Source is a list of discrete files** → multiple `cdn upload` lines back-to-back, then a loop of `curl -sIf` checks (one per public URL). `set -e` ensures the script halts on the first failed upload rather than silently skipping ahead.

One script per detected OS handles the whole batch.

### Flow

1. Run the filename sanitization check; if any names change, preview them and wait for the user's go-ahead.
2. Detect OS from the user's workspace folder path.
3. Write the script(s) to the Cowork outputs folder, using the naming + sanitization rules above.
4. **`chmod +x` the script(s) before surfacing them.** Run `chmod +x <script-path>` via the bash tool for every `.command` (macOS) and `.sh` (Linux) file you just wrote. Skip for `.bat` (Windows runs cmd scripts regardless of POSIX perms). Without the executable bit, double-click in Finder fails with *"could not be executed because you do not have appropriate access privileges"* — a different error from Gatekeeper, and right-click → Open does not fix it. Cowork preserves the executable bit through `present_files` to the host filesystem (verified 2026-05-21).
5. Call `mcp__cowork__present_files` with the file path(s) so they appear as clickable cards in chat.
6. Tell the user what to do. Suggested phrasing when a single OS was detected:

   > I've prepared a `.command` upload script. Double-click it to run. (First time, you may need to right-click → Open to bypass macOS's 'unidentified developer' Gatekeeper warning.)
   >
   > (If you're on Linux/Windows instead, let me know and I'll regenerate.)

   When detection was ambiguous and all three were emitted:

   > I've prepared upload scripts for Mac, Linux, and Windows. Double-click the one for your OS. On macOS, first-time runs need right-click → Open to bypass Gatekeeper.

7. **Wait for the user to confirm** completion ("done", "uploaded", "finished", or a pasted-back success line). Don't proceed without confirmation.
8. Verify via `cdn_get_stats` (see *After the user reports done* below).

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

### If the CLI isn't installed

Don't try to detect this in advance — the CLI lives on the *host*, not in the sandbox, so any `which cdn` probe from the sandbox always fails. Assume it's installed; if the user's Terminal reports `cdn: command not found` after double-clicking, walk them through the one-time install, then have them re-run the same script:

> Looks like the `cdn` CLI isn't installed yet. One-time install:
>
> ```bash
> gh release download v0.1.0 --repo code22d/cdn-cli --pattern "*.tgz" --dir /tmp \
>   && npm install -g /tmp/22d-cdn-cli-0.1.0.tgz
> ```
>
> Then set up the CLI config (`cdn config set r2.accessKeyId <…>` / `cdn config set r2.secretAccessKey <…>` / `cdn config set mcp.token <…>` — see the cdn-cli README for the values). Once that's done, double-click the upload script again.

There is no alternate upload transport — the script they already have is the path; it just needs the CLI present.

### What the skill does *not* do for Path E

- Don't try to run the `cdn` command yourself from inside the sandbox. The CLI is installed on the user's host, not in Cowork. The script runs on the host; the skill verifies after.
- Don't try to detect whether the CLI is installed before generating the script. Assume it is; the user's terminal surfaces the truth.
- **DO `chmod +x` the script before `present_files`** (for `.command` and `.sh` only — `.bat` doesn't need it). Cowork preserves the executable bit through Save to the host filesystem (verified 2026-05-21). Without it, double-click in Finder fails with *"could not be executed because you do not have appropriate access privileges"*, and right-click → Open does NOT fix that error — it only bypasses Gatekeeper's first-run "unidentified developer" warning, which is a separate issue.
- Don't ask the user what OS they're on. The workspace folder path is reliable; fall back to emitting all three if it's ambiguous.
- Don't embed `MCP_AUTH_TOKEN` or any other secret in the script. The CLI reads credentials from `~/.config/cdn-cli/` on the host; the verification step is an unauthenticated HEAD request to a public URL.
- Don't pre-print a copy-paste `cdn upload …` command. The clickable script is the only Path E output.
- Don't fall back to base64 (`cdn_upload_file`) or signed-URL (`cdn_signed_upload_url` + `cdn_finalize_upload`) flows — those MCP tools exist on the connector but this skill doesn't invoke them.

## Optional: image compression (only when user asks)

If the user explicitly asks to compress images before upload ("compress these first", "web-optimize", "make them smaller"), use Pillow in the sandbox, then upload the compressed outputs via Path E. Don't auto-route to compression for large images — Path E preserves originals by default, which is almost always what the user wants.

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

The CLI runs on the host and won't see sandbox `/tmp` paths — copy the compressed outputs to a host-mounted folder (e.g. `~/decks/Q2-pitch-web/`) before generating the Path E script. After uploading, mention:

> Uploaded as JPEG at 1920px width, quality 85. Originals at `<source>` are unchanged.

The user controls whether to delete originals — never auto-delete.

## Validation after upload

After every successful upload:

1. Call `cdn_get_stats()`. Compare new totals to what you uploaded.
2. Print a clean summary:

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
| User reports `cdn: command not found` after double-clicking | CLI not installed | Print the one-time install command (see *If the CLI isn't installed*), then have them re-run the same script. |
| User reports `cdn` errors with `missing required config` | CLI installed but config not set up | Tell the user to run `cdn config set r2.accessKeyId <…>` / `cdn config set r2.secretAccessKey <…>` / `cdn config set mcp.token <…>` (the three required fields). Point at cdn-cli README for the values. |
| User reports `cdn` errors with `file_exists` | Target already exists; CLI guards against accidental overwrites | Ask the user whether to overwrite. If yes, regenerate the script with `--replace` appended. |
| File doesn't exist when you `stat` it | Probably a typo, or the file is outside mounted folders | List the missing files and ask the user to clarify or mount the parent folder. |
| Sandbox bash can't read the file (permission denied) | File is on a non-mounted volume | Ask the user to mount the parent folder via Cowork's folder picker. |
| `.command` double-click does nothing, or "appropriate access privileges" error | Script wasn't `chmod +x`'d, or macOS Quarantine | `chmod +x` was missed — re-run it and re-present. For Gatekeeper, suggest right-click → Open. |
| Script's curl verification fails but `cdn upload` succeeded | Edge propagation delay, or sanitized name mismatch between the upload line and the verify URL | Wait a moment and `cdn list <project>` from the user's terminal, or check `cdn_list_files`. If the names mismatch, regenerate the script. |
| `cdn_get_stats` shows a smaller delta than expected | Some files in the batch didn't upload | Ask the user to re-run the script — `cdn upload-dir` with `--replace` is idempotent (re-uploads missing files, skips existing). Don't re-upload everything by hand. |

## What this skill should NOT do

- **Don't replace `cdn_help`.** That's the explainer tool. This is the executor.
- **Don't fire on uploads to other systems** — Slack, Drive, Notion, GitHub, S3, Dropbox, iCloud. The trigger is specifically the personal CDN at `cdn.22d.app` / the `cdn-mcp` connector.
- **Don't invoke the MCP upload tools** (`cdn_upload_file`, `cdn_signed_upload_url`, `cdn_finalize_upload`). They remain available on the connector for ad-hoc use, but this skill's only upload transport is the clickable script + local CLI.
- **Don't auto-detect the CLI** via `which cdn` or any other sandbox probe. The CLI runs on the host; sandbox detection always fails. Assume installed; let the user's terminal surface the truth.
- **Don't upload an unsafe filename silently.** If the basename has characters outside `[a-zA-Z0-9._-]`, show the proposed sanitized name and let the user override before generating the script.
- **Don't auto-route to compression** for large images. Compression is opt-in only.
- **Don't auto-delete originals after compression.** The user owns that decision.
- **Don't run uploads without confirming the project.** A wrong project name creates wrong URLs and cleanup is annoying.
- **Don't `curl` from the sandbox** trying to bypass the MCP. The sandbox proxy returns 403 on outbound HTTPS. The script runs on the *user's* machine, where curl works.

## Sample interactions

### Sample A — single file, clean name

User: *"Upload `~/videos/q2-demo.mp4` (180 MB) to project `videos`"*

You:
1. Basename `q2-demo.mp4` is clean — no sanitization preview needed.
2. Detect OS from the workspace path (`/Users/rene/…` → macOS).
3. Write `upload-q2-demo.mp4.command` to the Cowork outputs folder using the bash template — filled in with project `videos`, absolute path `/Users/rene/videos/q2-demo.mp4`, filename `q2-demo.mp4`. `chmod +x`.
4. Call `mcp__cowork__present_files` with that one file.
5. Tell the user: *"I've prepared a `.command` upload script. Double-click to run — it'll upload and verify. On Mac, first time, right-click → Open to bypass Gatekeeper."*
6. User: *"done"*.
7. `cdn_get_stats({project: "videos"})` → confirm file_count +1, total_size_bytes +180 MB.
8. *"✅ Uploaded — https://cdn.22d.app/videos/q2-demo.mp4"*

### Sample B — single file, unsafe name (sanitization preview)

User: *"Upload `~/Desktop/Q3 Report (FINAL).pdf` to project `proposals`"*

You:
1. Basename has spaces and parens → sanitized: `Q3_Report__FINAL_.pdf`. Show the preview:

   > The filename contains characters that don't URL-encode cleanly. I'll upload it as:
   >
   > `Q3_Report__FINAL_.pdf`
   >
   > Reply with a different name if you want, otherwise I'll proceed.

2. User: *"call it q3-report-final.pdf"* — validate (clean) and use it.
3. Write `upload-q3-report-final.pdf.command` — the `cdn upload` line keeps the original source path `"/Users/rene/Desktop/Q3 Report (FINAL).pdf"` and adds `--name "q3-report-final.pdf"`. Verify URL uses the new name. `chmod +x`, present, wait for "done".
4. `cdn_get_stats` → *"✅ Uploaded — https://cdn.22d.app/proposals/q3-report-final.pdf"*

### Sample C — directory batch

User: *"Upload all 17 deck images from `~/decks/Q2-pitch/` to project `decks`"*

You:
1. List the directory — all 17 basenames clean → no sanitization needed.
2. Detect OS (`/Users/rene/…` → macOS).
3. Write `upload-decks-batch.command` — single `cdn upload-dir "decks" "/Users/rene/decks/Q2-pitch"` line in the script. Skip per-file `curl` verification for directories; rely on `cdn_get_stats` after.
4. `chmod +x`, call `mcp__cowork__present_files` with the script.
5. Tell user: *"I've prepared `upload-decks-batch.command`. Double-click to run."* + Gatekeeper note.
6. User: *"done"*.
7. `cdn_get_stats({project: "decks"})` → confirm file_count +17 and size delta matches.
8. Print summary + a few sample URLs.

### Sample D — CLI not installed

User: *"the Terminal said `zsh: command not found: cdn`"*

You:
1. Print the one-time install command + config setup pointer (see *If the CLI isn't installed*).
2. User installs, double-clicks the **same script** again.
3. User: *"done"*.
4. `cdn_get_stats` → verify → *"✅ Uploaded — https://cdn.22d.app/videos/q2-demo.mp4"*

### Sample E — user wants compression first (opt-in)

User: *"Compress all the PNGs in `~/decks/Q2-pitch/` to web-optimized JPEGs first, then upload to `decks`"*

You:
1. Run the Pillow compression recipe → outputs in `/tmp/cdn-compressed/`.
2. Copy outputs to a host-mounted folder (e.g. `~/decks/Q2-pitch-web/`) so the CLI can see them.
3. Path E: script with `cdn upload-dir "decks" "/Users/rene/decks/Q2-pitch-web"`.
4. Verify + summary, noting the compression settings (1920px, quality 85).

## References

- The cdn-cli's README at `~/Documents/Claude/Local Folder/cdn-cli/README.md` documents the canonical `cdn upload` / `cdn upload-dir` flags and config setup.
- The original 5-path design rationale lives in `~/Documents/Claude/Projects/CDN w MCP/cdn_file_upload_skill_design.md` — kept as historical context. The current Path-E-only routing supersedes it.

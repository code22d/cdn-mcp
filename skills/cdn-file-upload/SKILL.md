---
name: cdn-file-upload
description: Upload files of any size or type to Rene's personal CDN at cdn.22d.app via the cdn-mcp connector. Use this skill whenever the user wants to host, upload, or publish files on the CDN — phrases like "upload to cdn.22d.app", "host on the CDN", "put these on the CDN", "upload to cdn-mcp", "host this image/video/asset/deck", or any request to make local files publicly reachable through cdn.22d.app. The skill picks the right transport automatically (direct base64, subagent fan-out, signed URL + .command script, or compress-then-upload) based on file size, batch size, and quality preferences. Prefer this skill over ad-hoc base64 uploads — its decision tree handles the "MCP payload too big" failures that trip up naive direct uploads on files larger than ~3 MB. Do NOT fire when the user means uploads to other systems (GitHub, Slack, Drive, Notion, S3, Dropbox, iCloud, etc.) — only when the destination is the personal CDN at cdn.22d.app or the cdn-mcp connector.
---

# cdn-file-upload

Upload single files or batches of any size or type to the personal CDN at `cdn.22d.app` via the `cdn-mcp` connector. The skill is responsible for picking the right transport — most upload failures on this CDN trace back to choosing the wrong path for the file size — so most of this document is a decision tree plus the specifics of each path.

The companion `cdn_help` MCP tool documents the CDN architecture if you need orientation. This skill is for *executing* uploads, not explaining them.

## Why this skill exists

The naive approach — read file, base64-encode, call `cdn_upload_file` — works fine for small files but fails silently or with cryptic errors on anything larger than ~3 MB. The reasons are not obvious:

- The Cowork sandbox blocks outbound HTTPS by default, so the sandbox cannot `curl` even to Rene's own Workers. The MCP layer is the only pipe for bytes from the sandbox.
- MCP JSON-RPC payloads have practical caps. A 6–8 MB image base64-encodes to ~10 MB of JSON, and that begins to fail intermittently. A 100 MB video fails outright.
- Subagent fan-out (one subagent per file) helps with batches but inherits the same per-message payload cap. It does not lift the size limit on a single file.
- The user can run `curl` on their own machine, but Cowork cannot type into Terminal (Terminal is a tier-"click" app — typing is blocked at the OS-tier level for security).

The combination of those constraints is why Path C (`.command` files written to a mounted folder, double-clicked by Rene) exists. Without it, files larger than a few MB are unreachable.

## Pre-flight checks (do these first, every time)

Before doing anything, verify:

1. **The cdn-mcp connector is reachable.** Tools like `cdn_upload_file`, `cdn_signed_upload_url`, `cdn_finalize_upload`, `cdn_get_stats` should appear in the available tools. If they don't, tell the user: *"The cdn-mcp connector isn't configured in this session. Add it via claude.ai → Settings → Customize → Connectors. Run `cdn_help` once it's connected for the URL pattern."* Then stop.
2. **The user has specified what to upload.** A file path, a directory, or attached files. If unclear, ask before guessing.
3. **The user has specified a target project.** The project is the first path segment in the public URL (`cdn.22d.app/<project>/<filename>`). If not specified, ask: *"Which CDN project should I upload to? (e.g., `blog`, `videos`, `proposals`, `decks`)"* Project names match `^[a-zA-Z0-9_-]+$`, max 64 chars — no dots, no spaces.

## Decision tree

For each file (or for the batch as a whole when the files are roughly uniform):

1. **Get the file size.** In the sandbox: `stat -c%s <file>` on Linux, `stat -f%z <file>` on macOS. The sandbox is Linux, so use the Linux form unless you're shelling into the user's native environment.

2. **Detect content type from extension.** Use the same MIME map as the MCP's `inferContentType` so what you send matches what `cdn_upload_file` would have inferred:

   | Extension | Content-Type |
   | --- | --- |
   | png | image/png |
   | jpg, jpeg | image/jpeg |
   | gif | image/gif |
   | webp | image/webp |
   | svg | image/svg+xml |
   | mp4 | video/mp4 |
   | webm | video/webm |
   | mp3 | audio/mpeg |
   | html, htm | text/html |
   | css | text/css |
   | js | application/javascript |
   | json | application/json |
   | txt | text/plain |
   | pdf | application/pdf |

   Anything else falls back to `application/octet-stream`.

3. **(Optional) Detect a local CLI.** Run `which cdn 2>/dev/null && cdn --version`. If `cdn` is installed, prefer Path E. As of v1 of this skill, the CLI doesn't exist yet — this check costs ~10 ms and lets the skill auto-upgrade the day Rene installs it without a rewrite. See *Path E* at the bottom.

4. **Pick the path:**

   - The user explicitly asked to **preserve quality** / **keep originals** / **no compression** → **Path C**.
   - Size **≤ 1 MB** → **Path A**.
   - Size **1–3 MB**, batch **≤ 5 files** → **Path A** (per file) or **Path B** (parallel) — your call. Path B is faster but adds subagent overhead; for ≤5 files at this size, Path A is usually simpler.
   - Size **1–3 MB**, batch **> 5 files** → **Path B**.
   - Size **> 3 MB**, file is an **image** (png/jpg/jpeg/webp), user **hasn't** specified quality → **ask** the compression question (template below). If they pick compress: **Path D**. If preserve: **Path C**.
   - Anything else (non-image > 3 MB, or images user wants preserved) → **Path C**.

   **Compression question template** (use exactly this phrasing, or close to it — the user has heard it before and recognizes the choice):

   > These are >3 MB images. I can either (a) compress them to ~500 KB JPEGs at 1920px width (visually identical for web display, fits through base64) and upload via the MCP, or (b) preserve the originals and write a `.command` script for you to double-click. Compress or preserve?

   For files in a batch with **mixed sizes**, classify each file independently, group by chosen path, and upload each group with its appropriate path. Don't force every file in the batch to take the same path.

## Path A — Direct base64

For files small enough to fit comfortably through the MCP. Reliable up to ~1 MB; usable up to ~3 MB if you must.

```
For each file:
  bytes  = read <file> from disk
  b64    = base64-encode(bytes)
  result = cdn_upload_file(
             project=<proj>,
             name=<basename or sub/path/name>,
             content_base64=b64,
             content_type=<inferred>,
           )
  print result.url
```

Note that `name` accepts forward slashes (e.g. `2026-05/hero.png`) for sub-path organization within a project, but no leading slash, no leading dot, no `..` segments.

## Path B — Subagent fan-out

For batches of small-to-medium files. Each subagent reads + encodes one file in *its own* context, returns just the URL string. The parent context never holds the base64, so even a 50-file batch doesn't blow up the parent's token count.

```
For each file:
  spawn subagent (general-purpose) with prompt:
    "Read /path/to/<file>, base64-encode the bytes, then call
     mcp__<cdn-connector>__cdn_upload_file with:
       project=<proj>, name=<basename>, content_base64=<encoded>,
       content_type=<inferred>.
     Return ONLY the public URL string. Do not echo the base64 in your response."

Parent collects N URLs.
```

**Hard limit:** Path B is reliable up to **~3 MB per file**. Above that, the JSON-RPC payload cap fires and the upload either fails outright or stalls silently. Don't reach for Path B as a workaround for large files — go to Path C or D.

## Path C — Signed URL + `.command` file

For files larger than ~3 MB where quality must be preserved, or any case where the batch is uniformly large. The skill writes a double-clickable `.command` shell script to a mounted folder; Rene double-clicks it; macOS opens Terminal and runs `curl` against the signed URLs. This bypasses both the MCP payload cap and the sandbox's curl block — the user's native machine has full network access.

The flow:

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
- The `read -p` at the end keeps the Terminal window open so Rene can see the output. If you remove it, the window closes immediately on success.
- Use `--data-binary @<file>` not `-d @<file>` — the former preserves bytes exactly; the latter strips newlines.

### Why `.command` and not a `.sh`

macOS treats `.command` files as double-clickable shell scripts that open in Terminal. A `.sh` file opens in the default text editor instead. The user's flow is "double-click in Finder, watch it run, tell Claude done" — a `.command` makes that flow work without typing anything into Terminal (which Cowork can't do anyway).

## Path D — Compress then base64

For images >3 MB where the user is OK with web-optimized quality. Compresses with Pillow in the sandbox, then uploads via Path A or B.

```bash
# 1. Ensure Pillow is installed (idempotent, no-ops if already there).
pip install --break-system-packages Pillow >/dev/null 2>&1

# 2. Compress.
python3 - <<'PY'
from PIL import Image
import os, sys

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

Then upload from `/tmp/cdn-compressed/` via Path A or Path B. After uploading, mention in the response:

> Uploaded as JPEG at 1920px width, quality 85. Originals at `<source>` are unchanged.

The user controls whether to delete originals — never auto-delete.

## Path E — `cdn-cli` invocation (dormant for v1)

This path exists for forward compatibility. The eventual `@22d/cdn-cli` reads files directly from disk and streams to R2 via S3 multipart, with no payload caps. When it ships, the skill detects it via `which cdn` in step 3 of the decision tree and uses it instead of writing `.command` files.

When `cdn` is installed:

```
1. Generate the CLI command:
     - Single file:  cdn upload <project> <abs-path-to-file>
     - Directory:    cdn upload-dir <project> <abs-path-to-dir>
2. Tell the user: "Run this in your terminal: <command>. Tell me when done."
3. After the user confirms — no separate finalize call needed (the CLI handled it).
4. Verify via cdn_get_stats() as usual.
```

Until the CLI exists, `which cdn` returns nothing and the skill falls through to Path C without comment.

## Validation after upload

After every successful upload (any path):

1. Call `cdn_get_stats()`. Compare new totals to what you uploaded.
2. For batches >5 files, optionally `curl` 1–2 random files and `sha256sum` against the originals to verify byte integrity. (For Path C this is gold-standard verification — it catches a wrong Content-Type header signed into the URL, which would let the PUT succeed but serve corrupt bytes.)
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
| `cdn_upload_file` errors with payload size | File is bigger than the MCP cap; you picked Path A/B for something that should be Path C | Fall back to Path C automatically. Tell the user you're switching: *"That's larger than direct upload handles cleanly — switching to a `.command` script."* |
| File doesn't exist when you `stat` it | Probably a typo, or the file is outside the mounted folders | List the missing files and ask the user to clarify or mount the parent folder. |
| Sandbox bash can't read the file (permission denied) | File is on a non-mounted volume | Ask the user to mount the parent folder via Cowork's folder picker. |
| `.command` double-click does nothing | macOS Quarantine, or the script wasn't `chmod +x`'d | Suggest right-click → Open, or `chmod +x <file>.command` from Terminal. |
| `curl` PUT fails inside `.command` | Likely an expired signed URL (>15 min between generation and double-click) or wrong Content-Type | Regenerate signed URLs (small batch — fast), rewrite the script. |
| Finalize fails after PUT succeeded | Bytes are in R2; the D1 row is missing | Retry `cdn_finalize_upload`. If it still fails, the bytes are still served at the public URL — tell the user, and check `cdn_list_files` to see whether the metadata caught up. |
| `cdn_get_stats` shows a smaller delta than expected | A subagent silently failed in Path B | Re-run only the missing files. Don't re-upload everything. |

## What this skill should NOT do

- **Don't replace `cdn_help`.** That's the explainer tool. This is the executor.
- **Don't fire on uploads to other systems** — Slack, Drive, Notion, GitHub, S3, Dropbox, iCloud. The trigger is specifically the personal CDN at `cdn.22d.app` / the `cdn-mcp` connector.
- **Don't auto-delete originals after compression.** The user owns that decision.
- **Don't run uploads without confirming the project.** A wrong project name creates wrong URLs and cleanup is annoying.
- **Don't generate a `.command` script that runs blind.** Always print a brief summary of what's about to happen — file count, target project, total size — before telling the user to double-click.
- **Don't `curl` from the sandbox** trying to bypass the MCP. The sandbox proxy returns 403 on outbound HTTPS. Path C's `.command` runs on the *user's* machine, where curl works.

## Sample interactions

### Sample A — single small file

User: *"Upload `~/blog/hero.png` to project `blog`"*

You:
1. `stat`: 412 KB, image/png.
2. Path A.
3. `cdn_upload_file` → success.
4. *"✓ Uploaded → https://cdn.22d.app/blog/hero.png (412 KB)"*

### Sample B — medium batch

User: *"Upload all PNGs in `~/blog/posts/2026-05/` to project `blog`"*

You:
1. List: 8 PNGs, 200 KB–2 MB each.
2. All <3 MB; batch >5 → Path B.
3. Spawn 8 subagents.
4. Collect 8 URLs, print summary.

### Sample C — large image batch (the canonical case)

User: *"Upload all 17 deck images from `~/decks/Q2-pitch/` to project `decks`"*

You:
1. List: 17 PNGs, 6–8 MB each.
2. Files >3 MB, are images, no quality preference stated.
3. Ask the compression question.
4. User picks "preserve quality" → Path C.
5. Generate 17 signed URLs.
6. Write `upload-batch.command` to `~/Documents/Claude/Projects/CDN w MCP/uploads/`, `chmod +x`.
7. *"Double-click upload-batch.command. I'll wait."*
8. User: *"done."*
9. `cdn_finalize_upload` × 17.
10. Verify via `cdn_get_stats`.
11. Print summary with all 17 URLs.

### Sample D — large video, single file

User: *"Upload `~/videos/q2-demo.mp4` (180 MB) to project `videos`"*

You:
1. `stat`: 180 MB, video/mp4.
2. Non-image, >3 MB → Path C (no compression question — videos go straight to Path C).
3. `cdn_signed_upload_url` → URL.
4. Write `upload-q2-demo.command` (single curl PUT).
5. *"Double-click `upload-q2-demo.command` — will take 30–60 sec depending on your connection. Tell me when done."*
6. User: *"done"*
7. `cdn_finalize_upload` → success.
8. Print public URL.

## References

The full design rationale, including future enhancements (resume-failed-uploads, parallel curl in `.command`, cross-platform `.sh` for non-mac partners) lives in `~/Documents/Claude/Projects/CDN w MCP/cdn_file_upload_skill_design.md`. Read it if you hit an edge case the table above doesn't cover.

#!/bin/bash
# build.sh — package the cdn-mcp-plugin for distribution.
#
# Copies the canonical cdn-file-upload skill from cdn-mcp/skills/ into
# cdn-mcp/plugin/skills/, validates the plugin.json manifest, and zips the
# plugin/ directory contents into cdn-mcp-plugin.plugin at the repo root.
#
# Run from anywhere:  bash plugin/build.sh
# Run from cdn-mcp/:  bash plugin/build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$SCRIPT_DIR"
SKILL_SRC="$REPO_ROOT/skills/cdn-file-upload"
SKILL_DST="$PLUGIN_DIR/skills/cdn-file-upload"
MANIFEST="$PLUGIN_DIR/.claude-plugin/plugin.json"
ARTIFACT_NAME="cdn-mcp-plugin.plugin"
ARTIFACT_OUT="$REPO_ROOT/$ARTIFACT_NAME"
TMP_ARTIFACT="/tmp/$ARTIFACT_NAME"

# 1. Sanity checks on the source layout.
if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: plugin manifest not found at $MANIFEST" >&2
  exit 1
fi

if [ ! -d "$SKILL_SRC" ]; then
  echo "ERROR: canonical skill source not found at $SKILL_SRC" >&2
  exit 1
fi

# 2. Validate plugin.json is well-formed JSON with required fields.
echo "Validating plugin.json..."
node -e "
const m = JSON.parse(require('fs').readFileSync('$MANIFEST', 'utf8'));
const required = ['name', 'version', 'description', 'author'];
const missing = required.filter(k => !(k in m));
if (missing.length) {
  console.error('ERROR: missing required fields: ' + missing.join(', '));
  process.exit(1);
}
if (!/^[a-z0-9-]+\$/.test(m.name)) {
  console.error('ERROR: name must be kebab-case: ' + m.name);
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+/.test(m.version)) {
  console.error('ERROR: version must be semver: ' + m.version);
  process.exit(1);
}
console.log('  name:    ' + m.name);
console.log('  version: ' + m.version);
console.log('  author:  ' + (m.author && m.author.name));
"

# 3. Refresh the skill from the canonical source.
echo "Copying skill source: $SKILL_SRC -> $SKILL_DST"
rm -rf "$SKILL_DST"
mkdir -p "$(dirname "$SKILL_DST")"
cp -R "$SKILL_SRC" "$SKILL_DST"

# 4. Zip plugin/ contents into the .plugin artifact.
#    - Build in /tmp first, then move (per create-cowork-plugin docs;
#      writing direct to repo root can fail under sandboxed permissions).
#    - Exclude build.sh itself, .DS_Store noise, and any zip artifacts.
echo "Zipping plugin contents into $ARTIFACT_NAME..."
rm -f "$TMP_ARTIFACT"
(
  cd "$PLUGIN_DIR"
  zip -qr "$TMP_ARTIFACT" . \
    -x "build.sh" \
    -x "*.DS_Store" \
    -x "$ARTIFACT_NAME"
)

mv "$TMP_ARTIFACT" "$ARTIFACT_OUT"

# 5. Report.
SIZE_BYTES=$(wc -c < "$ARTIFACT_OUT" | tr -d ' ')
SIZE_KB=$(( (SIZE_BYTES + 1023) / 1024 ))
echo ""
echo "Built $ARTIFACT_OUT (${SIZE_BYTES} bytes, ~${SIZE_KB} KB)"
echo "Contents:"
unzip -l "$ARTIFACT_OUT" | sed 's/^/  /'
echo ""
echo "Done. Next: gh release create plugin-v\$(node -p \"require('$MANIFEST').version\") $ARTIFACT_OUT"

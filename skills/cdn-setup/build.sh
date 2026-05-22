#!/bin/bash
# build.sh — package the cdn-setup skill for distribution.
#
# Zips the SKILL.md + scripts/ in skills/cdn-setup/ into cdn-setup.skill at
# the repo root. Mirrors plugin/build.sh in style and flags for visual
# parallelism with the plugin release lineage.
#
# Run from anywhere:  bash skills/cdn-setup/build.sh
# Run from cdn-mcp/:  bash skills/cdn-setup/build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILL_DIR="$SCRIPT_DIR"
SKILL_MD="$SKILL_DIR/SKILL.md"
PKG_JSON="$SKILL_DIR/package.json"
ARTIFACT_NAME="cdn-setup.skill"
ARTIFACT_OUT="$REPO_ROOT/$ARTIFACT_NAME"
TMP_ARTIFACT="/tmp/$ARTIFACT_NAME"

# 1. Sanity checks on the source layout.
if [ ! -f "$SKILL_MD" ]; then
  echo "ERROR: SKILL.md not found at $SKILL_MD" >&2
  exit 1
fi

if [ ! -f "$PKG_JSON" ]; then
  echo "ERROR: skill package.json not found at $PKG_JSON" >&2
  exit 1
fi

if [ ! -d "$SKILL_DIR/scripts" ]; then
  echo "ERROR: scripts/ directory not found at $SKILL_DIR/scripts" >&2
  exit 1
fi

# 2. Validate package.json is well-formed JSON with required fields.
echo "Validating skill package.json..."
node -e "
const m = JSON.parse(require('fs').readFileSync('$PKG_JSON', 'utf8'));
const required = ['name', 'version', 'description'];
const missing = required.filter(k => !(k in m));
if (missing.length) {
  console.error('ERROR: missing required fields: ' + missing.join(', '));
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+/.test(m.version)) {
  console.error('ERROR: version must be semver: ' + m.version);
  process.exit(1);
}
console.log('  name:    ' + m.name);
console.log('  version: ' + m.version);
"

# 3. Zip skill contents into the .skill artifact.
#    - Build in /tmp first, then move (per create-cowork-plugin docs;
#      writing direct to repo root can fail under sandboxed permissions).
#    - Exclude build.sh itself, .DS_Store noise, RELEASE-NOTES.md (release
#      asset, not skill content), and any zip artifacts.
echo "Zipping skill contents into $ARTIFACT_NAME..."
rm -f "$TMP_ARTIFACT"
(
  cd "$SKILL_DIR"
  zip -qr "$TMP_ARTIFACT" . \
    -x "build.sh" \
    -x "RELEASE-NOTES.md" \
    -x "package.json" \
    -x "*.DS_Store" \
    -x "$ARTIFACT_NAME"
)

mv "$TMP_ARTIFACT" "$ARTIFACT_OUT"

# 4. Report.
SIZE_BYTES=$(wc -c < "$ARTIFACT_OUT" | tr -d ' ')
SIZE_KB=$(( (SIZE_BYTES + 1023) / 1024 ))
echo ""
echo "Built $ARTIFACT_OUT (${SIZE_BYTES} bytes, ~${SIZE_KB} KB)"
echo "Contents:"
unzip -l "$ARTIFACT_OUT" | sed 's/^/  /'
echo ""
echo "Done. Next: gh release create cdn-setup-v\$(node -p \"require('$PKG_JSON').version\") $ARTIFACT_OUT"

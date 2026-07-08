#!/usr/bin/env bash
# BytesBrains package forge — create a new aligned package repo from the template.
# Usage: ./scripts/new-package.sh <package-name> "<description>" [topic1,topic2,...]
set -euo pipefail

NAME="${1:?usage: new-package.sh <name> \"<description>\" [topics]}"
DESC="${2:?description required}"
TOPICS="${3:-}"
ORG="bytesbrains"
YEAR="$(date +%Y)"

echo "==> creating $ORG/$NAME from template"
gh repo create "$ORG/$NAME" --template "$ORG/package-template" --public \
  --description "$DESC" --homepage "https://bytesbrains.com"
sleep 3  # template copy is async

TMP="$(mktemp -d)"
gh repo clone "$ORG/$NAME" "$TMP/$NAME"
cd "$TMP/$NAME"

echo "==> token replacement"
grep -rl '{{PACKAGE_NAME}}\|{{DESCRIPTION}}\|{{YEAR}}' . --exclude-dir=.git | while read -r f; do
  sed -i '' -e "s/{{PACKAGE_NAME}}/$NAME/g" -e "s|{{DESCRIPTION}}|$DESC|g" -e "s/{{YEAR}}/$YEAR/g" "$f" 2>/dev/null \
    || sed -i -e "s/{{PACKAGE_NAME}}/$NAME/g" -e "s|{{DESCRIPTION}}|$DESC|g" -e "s/{{YEAR}}/$YEAR/g" "$f"
done
rm -rf scripts  # the forge stays in the template only
git add -A && git commit -m "forge: instantiate $NAME from package-template" && git push

echo "==> repo settings"
gh api -X PATCH "repos/$ORG/$NAME" \
  -F has_wiki=false -F has_projects=false \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=true \
  -F delete_branch_on_merge=true >/dev/null

echo "==> security: secret-scanning push protection + dependabot"
gh api -X PATCH "repos/$ORG/$NAME" --input - >/dev/null <<JSON || echo "  (security_and_analysis: may already be on)"
{"security_and_analysis":{"secret_scanning_push_protection":{"status":"enabled"}}}
JSON
gh api -X PUT "repos/$ORG/$NAME/vulnerability-alerts" >/dev/null || true

if [ -n "$TOPICS" ]; then
  echo "==> topics"
  JSON_TOPICS=$(printf '%s' "$TOPICS" | awk -F, '{printf "["; for(i=1;i<=NF;i++){printf "%s\"%s\"", (i>1?",":""), $i}; printf "]"}')
  gh api -X PUT "repos/$ORG/$NAME/topics" --input - >/dev/null <<JSON
{"names":$JSON_TOPICS}
JSON
fi

echo "==> done: https://github.com/$ORG/$NAME"
echo "REMINDER: add NPM_TOKEN secret for releases:  gh secret set NPM_TOKEN -R $ORG/$NAME"

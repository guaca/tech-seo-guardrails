#!/usr/bin/env bash
#
# Risk-based test selection: reads git diff and outputs which
# Playwright projects and grep patterns to run.
#
# Usage:
#   PROJECTS=$(./scripts/select-tests.sh)
#   npx playwright test $PROJECTS
#
# If no git diff is available (e.g., push to main), runs everything.
#
# Compatible with bash 3.2+ (macOS default).

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# ⚠️ CUSTOMIZE THESE PATHS FOR YOUR PROJECT ⚠️
# The arrays below define which file changes trigger which SEO tests.
# You MUST update these to match your project's folder structure!
# ──────────────────────────────────────────────────────────────────────────────

# Changes here run the FULL integration suite (DOM, metadata, rendering)
INTEGRATION_TRIGGERS=(
  "seo-checks.json"
  "playwright.config."
  "/seo/" "/head/" "/routing/" "/middleware/"
  "/templates/" "/sections/" "/layout/" "/snippets/" "/components/" "/app/" "/pages/"
  "tests/" "src/" "scripts/"
)

# Changes here ONLY run rendering checks (CSS, layouts, visual shifts)
RENDERING_TRIGGERS=(
  "/styles/" "/assets/" "/public/" "/static/"
  ".css" ".scss" ".less"
)

# Changes here ONLY run metadata checks (titles, descriptions, hreflang)
METADATA_TRIGGERS=(
  "/content/" "/locales/" "/translations/" "/i18n/" "/lang/"
)

# Default base branch for diff-based test selection. Override with:
#   BASE_BRANCH=origin/develop ./scripts/select-tests.sh
BASE_BRANCH="${BASE_BRANCH:-origin/main}"
CHANGED_FILES=$(git diff --name-only "$BASE_BRANCH" 2>/dev/null || echo "")

if [ -z "$CHANGED_FILES" ]; then
  # No diff available — run full suite
  echo "--project=unit --project=integration"
  exit 0
fi

RUN_UNIT=true
RUN_INTEGRATION=false
RUN_RENDERING_ONLY=false
RUN_METADATA_ONLY=false

# Helper function to check if a file matches any trigger in an array
matches_trigger() {
  local file="$1"
  shift
  local triggers=("$@")
  for trigger in "${triggers[@]}"; do
    if [[ "$file" == *"$trigger"* ]]; then
      return 0
    fi
  done
  return 1
}

# Analyze changed files to determine which tests to run.
while IFS= read -r file; do
  if [ -z "$file" ]; then continue; fi

  if matches_trigger "$file" "${INTEGRATION_TRIGGERS[@]}"; then
    RUN_INTEGRATION=true
  elif matches_trigger "$file" "${RENDERING_TRIGGERS[@]}"; then
    RUN_RENDERING_ONLY=true
  elif matches_trigger "$file" "${METADATA_TRIGGERS[@]}"; then
    RUN_METADATA_ONLY=true
  else
    # Default fallback: if we don't know what it is, run everything to be safe
    RUN_INTEGRATION=true
  fi
done <<< "$CHANGED_FILES"

# Build the command arguments
ARGS="--project=unit"

if [ "$RUN_INTEGRATION" = true ]; then
  ARGS="$ARGS --project=integration"
elif [ "$RUN_RENDERING_ONLY" = true ] && [ "$RUN_METADATA_ONLY" = true ]; then
  # Both rendering and metadata triggered — run full integration with combined grep
  ARGS="$ARGS --project=integration --grep=rendering|metadata"
elif [ "$RUN_RENDERING_ONLY" = true ]; then
  ARGS="$ARGS --project=integration --grep=rendering"
elif [ "$RUN_METADATA_ONLY" = true ]; then
  ARGS="$ARGS --project=integration --grep=metadata"
fi

echo "$ARGS"

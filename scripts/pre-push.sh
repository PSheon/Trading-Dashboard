#!/usr/bin/env bash
# Fast checks before a push: the three that most often turn CI red.
#   1. generated HTTP contract docs are current (docs/http-routes.md, docs/openapi.json)
#   2. pnpm typecheck
#   3. pnpm lint
# Install once per clone:  ln -s ../../scripts/pre-push.sh .git/hooks/pre-push
# Skip for one push:       git push --no-verify
# The full list CI runs is in .github/workflows/ci.yml (docs/ci-and-testing.md).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

step() { printf '\npre-push: %s\n' "$1"; }

step "build shared contracts and the api (cached when unchanged)"
pnpm exec turbo run build --filter=@trading-dashboard/api

step "HTTP contract docs"
node scripts/http-contract-docs.mjs --check || {
  echo "docs/http-routes.md is stale: run 'node scripts/http-contract-docs.mjs' and commit it." >&2; exit 1; }
node scripts/openapi.mjs --check || {
  echo "docs/openapi.json is stale: run 'node scripts/openapi.mjs' and commit it." >&2; exit 1; }

step "typecheck"
pnpm typecheck

step "lint"
pnpm lint

printf '\npre-push: all checks passed\n'

#!/usr/bin/env bash
# Deploys to production; runnable from anywhere. Flags go to scripts/deploy.mts:
#   ./deploy.sh              checks, migrations, build, deploy, smoke test
#   ./deploy.sh --dry-run    say what would change; change nothing
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci
exec npm run -s deploy -- "$@"

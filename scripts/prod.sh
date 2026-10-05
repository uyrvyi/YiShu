#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "${1:-}" = init ]; then
  exec sh scripts/dev.sh exec -T dev node scripts/prod-init-env.mjs
fi
if [ ! -f .local/phase12/local.env ]; then
  printf '%s\n' 'Run sh scripts/prod.sh init first (development container required).' >&2
  exit 1
fi
exec sh scripts/dev.sh --env-file .local/phase12/local.env --project-name yishu-phase12 --file docker-compose.prod.yml "$@"

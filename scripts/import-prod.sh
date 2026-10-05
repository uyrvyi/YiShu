#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -f .local/production/local.env ]; then
  printf '%s\n' 'Create the private source snapshot first; refusing to use rehearsal credentials.' >&2
  exit 1
fi
exec sh scripts/dev.sh --env-file .local/production/local.env \
  --project-name yishu-production --file docker-compose.prod.yml \
  --file docker-compose.import.yml "$@"

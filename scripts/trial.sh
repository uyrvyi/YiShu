#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test -f .local/production/trial.env
if [ "${1:-}" = --public ]; then
  shift
  exec sh scripts/dev.sh --env-file .local/production/trial.env \
    --project-name yishu-production --file docker-compose.prod.yml \
    --file docker-compose.import.yml --file docker-compose.trial-base.yml \
    --file docker-compose.trial.yml "$@"
fi
exec sh scripts/dev.sh --env-file .local/production/trial.env \
  --project-name yishu-production --file docker-compose.prod.yml \
  --file docker-compose.import.yml --file docker-compose.trial-base.yml "$@"

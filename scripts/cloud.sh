#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test -f .local/cloud/cloud.env
if [ "${1:-}" = --next ]; then
  shift
  exec docker compose --env-file .local/cloud/cloud.env --project-name yishu-cloud \
    --profile delivery -f docker-compose.prod.yml -f docker-compose.import.yml \
    -f docker-compose.trial-base.yml -f docker-compose.cloud.yml \
    -f docker-compose.next-release.yml "$@"
fi
exec docker compose --env-file .local/cloud/cloud.env --project-name yishu-cloud \
  --profile delivery -f docker-compose.prod.yml -f docker-compose.import.yml \
  -f docker-compose.trial-base.yml -f docker-compose.cloud.yml "$@"

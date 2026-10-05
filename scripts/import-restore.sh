#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test -s .local/production/source.dump
tables=$(sh scripts/import-prod.sh exec -T postgres psql -U yishu -d yishu -At \
  -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
if [ "$tables" != 0 ]; then
  printf '%s\n' 'Target is not empty; refusing to restore or remove existing data.' >&2
  exit 1
fi
sh scripts/import-prod.sh exec -T postgres pg_restore --username yishu --dbname yishu \
  --no-owner --no-acl --exit-on-error --single-transaction < .local/production/source.dump
printf '%s\n' 'Private target restored; grants and import verification are still required.'

#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")/.."
mkdir -p .local/production/backups
chmod 700 .local/production/backups
file=".local/production/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
trap 'rm -f "$file.partial"' EXIT
sh scripts/trial.sh exec -T postgres pg_dump --username yishu --dbname yishu \
  --format custom --no-owner --no-acl > "$file.partial"
mv "$file.partial" "$file"
printf '%s\n' "$file"

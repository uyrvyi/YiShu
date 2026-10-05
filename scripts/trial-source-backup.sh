#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")/.."
mkdir -p .local/production/source-backups
chmod 700 .local/production/source-backups
file=".local/production/source-backups/$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
trap 'rm -f "$file.partial"' EXIT
sh scripts/dev.sh exec -T postgres sh -c \
  'exec pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format custom --no-owner --no-acl' > "$file.partial"
mv "$file.partial" "$file"
printf '%s\n' "$file"

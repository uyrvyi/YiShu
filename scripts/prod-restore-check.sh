#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
file=${1:?Provide a rehearsal backup file}
case "$file" in .local/phase12/backups/*.dump) ;; *) printf '%s\n' 'Only isolated rehearsal backups allowed.' >&2; exit 1;; esac
[ -s "$file" ] || exit 1
database="yishu_restore_check_$(date -u +%Y%m%d%H%M%S)_$$"
created=0
cleanup() {
  if [ "$created" = 1 ]; then
    sh scripts/prod.sh exec -T postgres dropdb --username yishu --if-exists "$database"
  fi
}
trap cleanup EXIT
sh scripts/prod.sh exec -T postgres createdb --username yishu "$database"
created=1
sh scripts/prod.sh exec -T postgres pg_restore --username yishu --dbname "$database" --no-owner --no-acl --exit-on-error < "$file"
sh scripts/prod.sh exec -T postgres psql --username yishu --dbname "$database" --set ON_ERROR_STOP=1 --command 'GRANT USAGE ON SCHEMA public TO yishu_app; GRANT SELECT ON ALL TABLES IN SCHEMA public TO yishu_app' >/dev/null
sh scripts/prod.sh run --rm --no-deps api node deploy/verify-restore.mjs "$database"

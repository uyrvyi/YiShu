#!/bin/sh
set -eu
cd /opt/yishu-preview
old_tag=preview-20261004-touch-session
new_tag=preview-20261004-geographic
old_id=sha256:9ee057f5924afec8c9a414e3813ad7bed2f6dc3fab381fb3a7601692351eef2e
backup=preview.env.before-geographic-20261004
test "$(docker inspect yishu-cloud-preview-preview-1 --format '{{.Image}}')" = "$old_id"
grep -qx "PREVIEW_TAG=$old_tag" preview.env
test ! -e "$backup"
docker image inspect "yishu-cloud-preview:$new_tag" --format '{{.Id}}'
cp -p preview.env "$backup"
rollback() {
  cp -p "$backup" preview.env
  docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview
}
trap rollback HUP INT TERM
# Only the image tag changes; the existing token/home volumes stay in place.
sed -i "s/^PREVIEW_TAG=$old_tag$/PREVIEW_TAG=$new_tag/" preview.env
if ! docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview; then
  rollback
  exit 1
fi
trap - HUP INT TERM
docker inspect yishu-cloud-preview-preview-1 --format 'Image={{.Image}} Health={{.State.Health.Status}} Ports={{json .HostConfig.PortBindings}}'

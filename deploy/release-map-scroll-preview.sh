#!/bin/sh
set -eu
cd /opt/yishu-preview
old_tag=preview-20261004-geographic
new_tag=preview-20261004-map-scroll-lock-r2
old_id=sha256:39bcd4702b78b6be32a520d2e7f34dc844d7fdce4c7026e3914790195a1a6e5f
backup=preview.env.before-map-scroll-lock-r2-20261004
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
sed -i "s/^PREVIEW_TAG=$old_tag$/PREVIEW_TAG=$new_tag/" preview.env
if ! docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview; then
  rollback
  exit 1
fi
trap - HUP INT TERM
docker inspect yishu-cloud-preview-preview-1 --format 'Image={{.Image}} Health={{.State.Health.Status}} Ports={{json .HostConfig.PortBindings}}'

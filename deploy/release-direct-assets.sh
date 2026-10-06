#!/bin/sh
set -eu
stage=/opt/yishu-preview/direct-https-20261005
config=/opt/yishu/deploy/Caddyfile.cloud
case "${1:-}" in ''|r2) ;; *) exit 1 ;; esac
backup=$config.before-direct-package-assets-20261005${1:+-$1}
test ! -e "$backup"
gateway_image=$(docker inspect yishu-cloud-caddy-1 --format '{{.Config.Image}}')
docker run --rm --network none --entrypoint caddy -e CLOUD_PUBLIC_IP=8.136.121.71 \
  -v "$stage/Caddyfile.cloud:/etc/caddy/Caddyfile:ro" "$gateway_image" \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile
cp -p "$config" "$backup"
containers() {
  docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-postgres-1 \
    yishu-cloud-redis-1 yishu-cloud-maps-map-tiles-1 yishu-cloud-preview-preview-1 \
    --format '{{.Name}} {{.Image}} {{.State.StartedAt}}'
}
containers > "$stage/assets-before.txt"
rollback() {
  code=$?
  trap - EXIT HUP INT TERM
  cp -p "$backup" "$config"
  sh /opt/yishu/scripts/cloud.sh up -d --no-deps --force-recreate --wait --wait-timeout 120 caddy
  printf 'DIRECT_ASSETS_ROLLED_BACK\n'
  exit "$code"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM
cp "$stage/Caddyfile.cloud" "$config"
sh /opt/yishu/scripts/cloud.sh up -d --no-deps --force-recreate --wait --wait-timeout 120 caddy
docker exec -i yishu-cloud-preview-preview-1 node --input-type=module - https://8.136.121.71 \
  --letter-gallery --gallery-preload --route-fit-limit --upload-feedback --upload-optimized \
  --upload-progress --native-abort-compatible --upload-flow --smaller-photos --media-lifecycle \
  --any-direction-preview --persistent-preview-pan --preview-touch-session --geographic-map \
  --map-scroll-lock --static-tiles < "$stage/check-expo-preview.mjs"
curl --fail --silent --show-error --retry 3 https://8.136.121.71/api/v1/health
containers > "$stage/assets-after.txt"
cmp "$stage/assets-before.txt" "$stage/assets-after.txt"
trap - EXIT HUP INT TERM
printf '\nDIRECT_ASSETS_RELEASE_PASS\nPREVIEW_AND_BUSINESS_UNCHANGED_PASS\n'

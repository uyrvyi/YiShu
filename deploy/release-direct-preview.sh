#!/bin/sh
set -eu
stage=/opt/yishu-preview/direct-https-20261005
preview=/opt/yishu-preview
backend=/opt/yishu
case "${1:-}" in ''|r2) ;; *) exit 1 ;; esac
suffix=before-direct-https-20261005${1:+-$1}
image=yishu-cloud-preview:preview-20261005-gallery-preload
test "$(docker image inspect "$image" --format '{{.Id}}')" = sha256:2739035517bdf5ccab26a0985a5def5948331323fd5de6826172b9051addd9a9
test ! -e "$preview/preview.env.$suffix"
gateway_image=$(docker inspect yishu-cloud-caddy-1 --format '{{.Config.Image}}')
docker run --rm --network none --entrypoint caddy -e CLOUD_PUBLIC_IP=8.136.121.71 \
  -v "$stage/Caddyfile.cloud:/etc/caddy/Caddyfile:ro" "$gateway_image" \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile
cp -p "$preview/preview.env" "$preview/preview.env.$suffix"
cp -p "$preview/docker-compose.cloud-preview.yml" "$preview/docker-compose.cloud-preview.yml.$suffix"
cp -p "$backend/docker-compose.cloud.yml" "$backend/docker-compose.cloud.yml.$suffix"
cp -p "$backend/deploy/Caddyfile.cloud" "$backend/deploy/Caddyfile.cloud.$suffix"
business() {
  docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-postgres-1 \
    yishu-cloud-redis-1 yishu-cloud-maps-map-tiles-1 \
    --format '{{.Name}} {{.Image}} {{.State.StartedAt}}'
}
business > "$stage/business-before.txt"
rollback() {
  result=$?
  trap - EXIT HUP INT TERM
  cp -p "$backend/docker-compose.cloud.yml.$suffix" "$backend/docker-compose.cloud.yml"
  cp -p "$backend/deploy/Caddyfile.cloud.$suffix" "$backend/deploy/Caddyfile.cloud"
  sh "$backend/scripts/cloud.sh" up -d --no-deps --force-recreate --wait --wait-timeout 120 caddy
  docker stop yishu-cloud-preview-preview-1 || true
  cp -p "$preview/preview.env.$suffix" "$preview/preview.env"
  cp -p "$preview/docker-compose.cloud-preview.yml.$suffix" "$preview/docker-compose.cloud-preview.yml"
  printf 'DIRECT_PREVIEW_ROLLED_BACK\n'
  exit "$result"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM
cp "$stage/docker-compose.cloud-preview.yml" "$preview/docker-compose.cloud-preview.yml"
sed -i 's/^PREVIEW_TAG=.*/PREVIEW_TAG=preview-20261005-gallery-preload/' "$preview/preview.env"
cd "$preview"
docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview
docker exec -i yishu-cloud-preview-preview-1 node --input-type=module < "$stage/prewarm-national-preview.mjs"
cp "$stage/docker-compose.cloud.yml" "$backend/docker-compose.cloud.yml"
cp "$stage/Caddyfile.cloud" "$backend/deploy/Caddyfile.cloud"
sh "$backend/scripts/cloud.sh" up -d --no-deps --force-recreate --wait --wait-timeout 120 caddy
curl --fail --silent --show-error --retry 3 https://8.136.121.71/api/v1/health
docker exec -i yishu-cloud-preview-preview-1 node --input-type=module - https://8.136.121.71 \
  --letter-gallery --gallery-preload --route-fit-limit --upload-feedback --upload-optimized \
  --upload-progress --native-abort-compatible --upload-flow --smaller-photos --media-lifecycle \
  --any-direction-preview --persistent-preview-pan --preview-touch-session --geographic-map \
  --map-scroll-lock --static-tiles < "$stage/check-expo-preview.mjs"
business > "$stage/business-after.txt"
cmp "$stage/business-before.txt" "$stage/business-after.txt"
test "$(docker inspect yishu-cloud-preview-preview-1 --format '{{.State.Health.Status}}')" = healthy
docker inspect yishu-cloud-preview-preview-1 --format 'Image={{.Image}} Health={{.State.Health.Status}} Init={{.HostConfig.Init}} Readonly={{.HostConfig.ReadonlyRootfs}} Ports={{json .HostConfig.PortBindings}}'
trap - EXIT HUP INT TERM
printf '\nDIRECT_PREVIEW_RELEASE_PASS\nBUSINESS_CONTAINERS_UNCHANGED_PASS\n'

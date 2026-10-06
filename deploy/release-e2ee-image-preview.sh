#!/bin/sh
set -eu
umask 077
file_count=4
dockerfile=deploy/Dockerfile.cloud-e2ee-image
case "${1:-image}" in
  automatic)
    directory=/opt/yishu-preview/automatic-e2ee-20261006
    base_tag=preview-20261005-keyboard-all-r4
    next_tag=preview-20261006-auto-e2ee-r5
    base_id=sha256:6a881f6a31bd0e04050dda7130efa9d3ebd55b66bfe144ce0dec4738fcacc39f
    patch_source=apps/mobile/app/encryption.tsx
    file_count=11
    dockerfile=deploy/Dockerfile.cloud-mobile-patch
    ;;
  image)
    directory=/opt/yishu-preview/e2ee-image-20261005
    base_tag=preview-20261005-e2ee-reviewed-r1
    next_tag=preview-20261005-e2ee-image-r2
    base_id=sha256:5292f10249686a831144c2ec763cf38b5659c3b8063dad21eb75bf6b3f591c4c
    patch_source=apps/mobile/src/e2ee/client.ts
    ;;
  keyboard)
    directory=/opt/yishu-preview/keyboard-20261005
    base_tag=preview-20261005-e2ee-image-r2
    next_tag=preview-20261005-keyboard-r3
    base_id=sha256:e944c36571cf1cc63a016fe097bdb57593151ea945926d758d15d11a066eeffd
    patch_source=apps/mobile/app/letters/new.tsx
    ;;
  keyboard-all)
    directory=/opt/yishu-preview/keyboard-all-20261005
    base_tag=preview-20261005-keyboard-r3
    next_tag=preview-20261005-keyboard-all-r4
    base_id=sha256:e9431132f40ffba6e69c471314bac11408586d2602070b39ca8ba5d494010961
    patch_source=apps/mobile/app/letters/new.tsx
    file_count=10
    dockerfile=deploy/Dockerfile.cloud-keyboard
    ;;
  *) exit 1 ;;
esac
cd "$directory/context"
test "$(docker inspect yishu-cloud-preview-preview-1 --format '{{.Image}}')" = "$base_id"
test "$(find . -type f | wc -l)" -eq "$file_count"
test -z "$(find . -name '._*' -o -name '.env*' -o -name '*.pem' -o -name '*.key')"
docker build --network none --build-arg "PREVIEW_BASE_IMAGE=yishu-cloud-preview:$base_tag" \
  --build-arg "PATCH_SOURCE=$patch_source" \
  -f "$dockerfile" -t "yishu-cloud-preview:$next_tag" .
docker run --rm --init --network none --read-only --entrypoint node "yishu-cloud-preview:$next_tag" -e '
const fs = require("node:fs"), crypto = require("node:crypto");
const manifest = JSON.parse(fs.readFileSync("/workspace/e2ee-image-patch.json"));
for (const source of manifest.sources.filter(s => s.file.startsWith("apps/mobile/"))) {
  const bytes = fs.readFileSync("/workspace/" + source.file);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw Error("source_mismatch");
  if (/import\s*\(\s*["\x27]react-native["\x27]/.test(bytes.toString())) throw Error("unsafe_native_namespace_import");
}
console.log("E2EE_IMAGE_SOURCE_PASS");'
docker run --rm --init --network none --read-only --memory 1280m --pids-limit 192 --cpus 0.75 \
  --tmpfs /tmp:uid=1000,gid=1000,mode=1777,size=536870912 \
  --tmpfs /workspace/apps/mobile/.expo:uid=1000,gid=1000,mode=0700,size=67108864 \
  --tmpfs /home/node:uid=1000,gid=1000,mode=0700,size=134217728 \
  -e EXPO_PUBLIC_API_BASE_URL=https://8.136.121.71 \
  -e EXPO_PUBLIC_MAP_TILE_BASE_URL=https://8.136.121.71/maps/national-20261003-v2 \
  "yishu-cloud-preview:$next_tag" \
  node node_modules/expo/bin/cli export --platform ios --output-dir /tmp/export --max-workers 1
cd /opt/yishu-preview
backup="$directory/preview.env.before"
test ! -e "$backup"
grep -qx "PREVIEW_TAG=$base_tag" preview.env
cp -p preview.env "$backup"
docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 \
  --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > "$directory/business.before"
failed() {
  code=$?
  trap - EXIT HUP INT TERM
  cp -p "$backup" preview.env
  docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview
  exit "$code"
}
trap failed EXIT
trap 'exit 1' HUP INT TERM
sed -i "s/^PREVIEW_TAG=$base_tag\$/PREVIEW_TAG=$next_tag/" preview.env
docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview
docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 \
  --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > "$directory/business.after"
cmp "$directory/business.before" "$directory/business.after"
docker inspect yishu-cloud-preview-preview-1 --format '{{.Image}} {{.State.Health.Status}} {{.RestartCount}}' > "$directory/preview.after"
trap - EXIT HUP INT TERM
touch "$directory/release-pass"
printf 'E2EE_IMAGE_PREVIEW_RELEASE_PASS\nBUSINESS_CONTAINERS_UNCHANGED_PASS\n'

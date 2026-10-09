#!/bin/sh
set -eu
umask 077
file_count=8
dockerfile=deploy/Dockerfile.cloud-preview-gallery
manifest_file=gallery-patch.json
case "${2:-gallery}" in
  appearance)
    revision=appearance-20261008-r1
    base_tag=preview-20261008-letter-paper-preview-r4
    base_id=sha256:416818d2c77b7ecd7f99490e1aaa810257928c84bde61f67393c07b10b749daa
    next_tag=preview-20261008-appearance-r1
    file_count=33
    dockerfile=deploy/Dockerfile.cloud-mobile-patch
    manifest_file=e2ee-image-patch.json
    ;;
  paper-preview)
    revision=letter-paper-preview-20261008-r4
    base_tag=preview-20261008-letter-paper-preview-r3
    base_id=sha256:9b978c765e35e062034fc386e6a26c84fd74e58d86967d03b6f2bc16f7d0074d
    next_tag=preview-20261008-letter-paper-preview-r4
    file_count=6
    dockerfile=deploy/Dockerfile.cloud-mobile-patch
    manifest_file=e2ee-image-patch.json
    ;;
  envelope-geometry)
    revision=letter-envelope-geometry-20261008
    base_tag=preview-20261008-letter-paper-front-r1
    base_id=sha256:19537f3e6602a6471cea75df8279f52ad6d1cdc7def69dda96f68e27a0be3b42
    next_tag=preview-20261008-letter-envelope-geometry-r1
    file_count=5
    dockerfile=deploy/Dockerfile.cloud-mobile-patch
    manifest_file=e2ee-image-patch.json
    ;;
  paper-front)
    revision=letter-paper-front-20261008
    base_tag=preview-20261008-letter-continuous-paper-r1
    base_id=sha256:2eff6aee4e76508b0f11b812cbd660b341d9f4a811de646cab077e466905ad0f
    next_tag=preview-20261008-letter-paper-front-r1
    file_count=5
    dockerfile=deploy/Dockerfile.cloud-mobile-patch
    manifest_file=e2ee-image-patch.json
    ;;
  continuous-paper)
    revision=letter-continuous-paper-20261008
    base_tag=preview-20261007-letter-seal-hold-r1
    base_id=sha256:35a4137250c40e14dd6b1ba2066ca98287f6d69478f5bc7d4d6d4d1e7a1da2e0
    next_tag=preview-20261008-letter-continuous-paper-r1
    file_count=6
    dockerfile=deploy/Dockerfile.cloud-mobile-patch
    manifest_file=e2ee-image-patch.json
    ;;
  seal-hold)
    revision=letter-seal-hold-20261007
    base_tag=preview-20261007-letter-paper-center-r1
    base_id=sha256:6ff85e4ce0b083dcd58d6fdd8157df726af7bbb5b3894c76209a4ad27be8b737
    next_tag=preview-20261007-letter-seal-hold-r1
    file_count=5
    dockerfile=deploy/Dockerfile.cloud-mobile-patch
    manifest_file=e2ee-image-patch.json
    ;;
  paper-center)
    revision=letter-paper-center-20261007
    base_tag=preview-20261007-letter-paper-r1
    base_id=sha256:024bb2e18ec7c5eb5c6f341d475cceaced1ece0f3bb8967c11db0da909c2b423
    next_tag=preview-20261007-letter-paper-center-r1
    file_count=4
    dockerfile=deploy/Dockerfile.cloud-mobile-patch
    manifest_file=e2ee-image-patch.json
    ;;
  paper)
    revision=letter-paper-20261007
    base_tag=preview-20261007-letter-ritual-r1
    base_id=sha256:fc7166ad89bb4a83f309ef0015d3a57a97e326cf5e64a65c7c2e8c60aadbcee6
    next_tag=preview-20261007-letter-paper-r1
    file_count=6
    dockerfile=deploy/Dockerfile.cloud-mobile-patch
    manifest_file=e2ee-image-patch.json
    ;;
  ritual)
    revision=letter-ritual-20261007
    base_tag=preview-20261007-gallery-settle-r1
    base_id=sha256:79b0ec2c69d89b33555ea38c8f959c2593e6b7dd20805db11afab5e4f7907d02
    next_tag=preview-20261007-letter-ritual-r1
    file_count=8
    dockerfile=deploy/Dockerfile.cloud-mobile-patch
    manifest_file=e2ee-image-patch.json
    ;;
  settle)
    revision=gallery-settle-20261007
    base_tag=preview-20261006-gallery-motion-r1
    base_id=sha256:b89105d11a3c19cf2230084e55dc886a19578c0e01387c243bea6a3dc5bc23b9
    next_tag=preview-20261007-gallery-settle-r1
    file_count=5
    dockerfile=deploy/Dockerfile.cloud-mobile-patch
    manifest_file=e2ee-image-patch.json
    ;;
  motion)
    revision=gallery-motion-20261006
    base_tag=preview-20261006-transport-1-1-r1
    base_id=sha256:c0a5ff2a16acf028d9a2a0d2d4c5fcb42c9c68109f86a60c26038516a1a5d070
    next_tag=preview-20261006-gallery-motion-r1
    file_count=7
    dockerfile=deploy/Dockerfile.cloud-mobile-patch
    manifest_file=e2ee-image-patch.json
    ;;
  gallery)
    revision=gallery-20261005
    base_tag=preview-20261005-upload-feedback
    base_id=sha256:0ccef398af4d9efce6d91cbec148ebce777549877db03aa235bd9d655d250e64
    next_tag=preview-20261005-gallery
    ;;
  preload)
    revision=gallery-preload-20261005
    base_tag=preview-20261005-gallery
    base_id=sha256:1dff0d609b4b1b3a9ba4cf9ed3a34d699919eefaa674bb72d0ad518a0fcb4d26
    next_tag=preview-20261005-gallery-preload
    ;;
  *) exit 1 ;;
esac
directory=/opt/yishu-preview/$revision
image=yishu-cloud-preview:$next_tag
backup=preview.env.before-$revision
test "${#1}" -eq 64
mkdir -p "$directory/context"
cd "$directory"
test "$(sha256sum patch.tgz | cut -d' ' -f1)" = "$1"
tar -xzf patch.tgz -C context
test -z "$(find context -name '._*' -o -name '.env*' -o -name '.DS_Store')"
test "$(find context -type f | wc -l)" -eq "$file_count"
test "$(docker inspect yishu-cloud-preview-preview-1 --format '{{.Image}}')" = "$base_id"
cd context
docker build --network none --build-arg "PREVIEW_BASE_IMAGE=yishu-cloud-preview:$base_tag" -f "$dockerfile" -t "$image" .
docker run --rm --init --network none --read-only -e "MANIFEST_FILE=$manifest_file" --entrypoint node "$image" -e '
const fs = require("node:fs"), crypto = require("node:crypto");
const manifest = JSON.parse(fs.readFileSync("/workspace/" + process.env.MANIFEST_FILE));
for (const source of manifest.sources.filter(s=>s.file.startsWith("apps/mobile/"))) {
  const actual = crypto.createHash("sha256").update(fs.readFileSync("/workspace/" + source.file)).digest("hex");
  if (actual !== source.sha256) throw Error("source_mismatch:" + source.file);
}
console.log("GALLERY_SOURCE_PASS");'
if [ "${2:-gallery}" != appearance ] && [ "${2:-gallery}" != settle ] && [ "${2:-gallery}" != ritual ] && [ "${2:-gallery}" != paper ] && [ "${2:-gallery}" != paper-center ] && [ "${2:-gallery}" != seal-hold ] && [ "${2:-gallery}" != continuous-paper ] && [ "${2:-gallery}" != paper-front ] && [ "${2:-gallery}" != envelope-geometry ] && [ "${2:-gallery}" != paper-preview ]; then
  docker run --rm --init --network none --read-only --memory 1280m --pids-limit 192 --cpus 0.75 \
  --tmpfs /tmp:uid=1000,gid=1000,mode=1777,size=536870912 \
  --tmpfs /workspace/apps/mobile/.expo:uid=1000,gid=1000,mode=0700,size=67108864 \
  --tmpfs /home/node:uid=1000,gid=1000,mode=0700,size=134217728 \
  -e EXPO_PUBLIC_API_BASE_URL=https://8.136.121.71 \
  -e EXPO_PUBLIC_MAP_TILE_BASE_URL=https://8.136.121.71/maps/national-20261003-v2 \
  "$image" \
  node node_modules/expo/bin/cli export --platform ios --output-dir /tmp/export --max-workers 1
fi
cd /opt/yishu-preview
grep -qx "PREVIEW_TAG=$base_tag" preview.env
test ! -e "$backup"
cp -p preview.env "$backup"
docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 \
  --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > "$directory/business-before.txt"
rollback() {
  cp -p "$backup" preview.env
  docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview
}
failed_release() {
  code=$?
  trap - EXIT HUP INT TERM
  rollback
  exit "$code"
}
trap failed_release EXIT
trap 'exit 1' HUP INT TERM
sed -i "s/^PREVIEW_TAG=$base_tag\$/PREVIEW_TAG=$next_tag/" preview.env
docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait --wait-timeout 180 preview
if [ "${2:-gallery}" = appearance ] || [ "${2:-gallery}" = motion ] || [ "${2:-gallery}" = settle ] || [ "${2:-gallery}" = ritual ] || [ "${2:-gallery}" = paper ] || [ "${2:-gallery}" = paper-center ] || [ "${2:-gallery}" = seal-hold ] || [ "${2:-gallery}" = continuous-paper ] || [ "${2:-gallery}" = paper-front ] || [ "${2:-gallery}" = envelope-geometry ] || [ "${2:-gallery}" = paper-preview ]; then
  docker exec -i -e "CHECK_RITUAL=${2:-gallery}" yishu-cloud-preview-preview-1 node --input-type=module > "$directory/bundle-check.log" <<'JS'
import assert from 'node:assert/strict';
const response = await fetch('http://127.0.0.1:8081', {
  headers: { 'expo-platform': 'ios', accept: 'application/expo+json' },
  signal: AbortSignal.timeout(30000),
});
assert.equal(response.status, 200);
const manifest = await response.json();
const url = new URL(manifest.launchAsset.url);
assert.equal(url.hostname, '8.136.121.71');
url.protocol = 'http:';
url.hostname = '127.0.0.1';
url.port = '8081';
const asset = await fetch(url, { signal: AbortSignal.timeout(480000) });
assert.equal(asset.status, 200);
const bundle = (await asset.text()).replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
for (const symbol of ['image-preview-neighbor-', 'PINCH_DISMISS_ZOOM', 'renderPage', 'image-preview-current'])
  assert.ok(bundle.includes(symbol), 'missing:' + symbol);
if (['ritual', 'paper', 'paper-center', 'seal-hold', 'continuous-paper', 'paper-front', 'envelope-geometry', 'paper-preview'].includes(process.env.CHECK_RITUAL)) {
  for (const symbol of ['轻点骑缝章', 'openReadableLetter', '封好这封信', '关闭信封', '不能给自己寄信'])
    assert.ok(bundle.includes(symbol), 'missing:' + symbol);
}
if (process.env.CHECK_RITUAL === 'paper' || process.env.CHECK_RITUAL === 'paper-center') {
  for (const symbol of ['letter-paper', 'paper-reader', '展开信纸', '收起信纸'])
    assert.ok(bundle.includes(symbol), 'missing:' + symbol);
}
if (process.env.CHECK_RITUAL === 'paper-center') assert.ok(bundle.includes('paper-reader-top-space'), 'missing:centered-paper');
if (process.env.CHECK_RITUAL === 'seal-hold') assert.ok(bundle.includes('sealedHold'), 'missing:sealed-hold');
if (['continuous-paper', 'paper-front', 'envelope-geometry', 'paper-preview'].includes(process.env.CHECK_RITUAL)) {
  for (const symbol of ['continuous-reading-paper', 'reading-paper-content', 'opening-envelope-frame', 'entranceFrame', 'sealedHold'])
    assert.ok(bundle.includes(symbol), 'missing:' + symbol);
}
if (process.env.CHECK_RITUAL === 'envelope-geometry') {
  for (const symbol of ['envelope-outline', 'envelope-flap-art', 'sending-envelope-flap', 'opening-envelope-flap', 'sealLeft', 'flapSeam'])
    assert.ok(bundle.includes(symbol), 'missing:' + symbol);
}
if (process.env.CHECK_RITUAL === 'paper-preview') {
  for (const symbol of ['letter-paper-preview-content', 'letter-paper-preview-fade', 'paper-reader-clip', 'paper-reader-fade'])
    assert.ok(bundle.includes(symbol), 'missing:' + symbol);
  assert.ok(!bundle.includes('envelope-flap-art'), 'unexpected:unverified-envelope-patch');
}
if (process.env.CHECK_RITUAL === 'appearance') {
  assert.equal(manifest.extra.expoClient.userInterfaceStyle, 'automatic');
  for (const symbol of ['界面设置', '浅色模式', '深色模式', '跟随系统', 'yishu.appearance', 'yishuSetMapTheme', 'paper-reader-clip', 'paperInk', 'paperArtRule', '#252A2D', '#EBEEEF'])
    assert.ok(bundle.includes(symbol), 'missing:' + symbol);
  assert.ok(!bundle.includes('envelope-flap-art'), 'unexpected:unverified-envelope-patch');
  console.log('APPEARANCE_BUNDLE_PASS');
}
console.log(JSON.stringify({status:process.env.CHECK_RITUAL === 'paper-preview' ? 'PAPER_PREVIEW_BUNDLE_PASS' : process.env.CHECK_RITUAL === 'continuous-paper' ? 'CONTINUOUS_PAPER_BUNDLE_PASS' : process.env.CHECK_RITUAL === 'seal-hold' ? 'LETTER_SEAL_HOLD_BUNDLE_PASS' : ['paper', 'paper-center'].includes(process.env.CHECK_RITUAL) ? 'LETTER_PAPER_BUNDLE_PASS' : process.env.CHECK_RITUAL === 'ritual' ? 'LETTER_RITUAL_BUNDLE_PASS' : 'GALLERY_MOTION_BUNDLE_PASS', sdk:manifest.extra.expoClient.sdkVersion}));
JS
fi
docker inspect yishu-cloud-api-1 yishu-cloud-worker-1 yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 \
  --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > "$directory/business-after.txt"
cmp "$directory/business-before.txt" "$directory/business-after.txt"
test "$(docker inspect yishu-cloud-preview-preview-1 --format '{{.State.Health.Status}}')" = healthy
docker inspect yishu-cloud-preview-preview-1 --format 'Image={{.Image}} Health={{.State.Health.Status}} Ports={{json .HostConfig.PortBindings}}'
trap - EXIT HUP INT TERM
printf 'GALLERY_RELEASE_PASS\nBUSINESS_CONTAINERS_UNCHANGED_PASS\n'

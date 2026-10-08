#!/bin/sh
set -eu
umask 077
stage=/opt/yishu/releases/self-letter-policy-20261007
backend=/opt/yishu
base_id=sha256:53e5962df9090c5db346641cdb858e9d1d8146cc177c0c943971dee1f317841e
tag=self-letter-policy-20261007-r1
cd "$stage"
test "$(sha256sum patch.tgz | cut -d' ' -f1)" = "$1"
test ! -e cloud.env.before
test "$(docker inspect yishu-cloud-api-1 --format '{{.Image}}')" = "$base_id"
mkdir -p context
tar -xzf patch.tgz -C context
test "$(find context -type f | wc -l)" -eq 4
test -z "$(find context -name '.env*' -o -name '._*')"
docker exec yishu-cloud-api-1 node -e '
const hash=require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync("/workspace/apps/api/dist/routes/letters.js")).digest("hex");
if(hash!=="360af8ec383b1dad7f0f9fa782f9a763f480be9778c704c9129cfa2e75057d33")throw Error("Unexpected live route changes");'
test "$(sha256sum context/apps/api/dist/routes/letters.js | cut -d' ' -f1)" = 9fdc9a02f7d55e1bcbd8553d871e94b2ffc9fe703e28553bda446a6ee8d7be32
docker build --network none -f context/deploy/Dockerfile.cloud-letter-policy -t "yishu-server:$tag" context
docker inspect yishu-cloud-worker-1 yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 yishu-cloud-preview-preview-1 --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > other-services.before
cp -p "$backend/.local/cloud/cloud.env" cloud.env.before
failed() {
  code=$?
  trap - EXIT HUP INT TERM
  cp -p "$stage/cloud.env.before" "$backend/.local/cloud/cloud.env"
  (cd "$backend" && sh scripts/cloud.sh --next up -d --no-deps --wait --wait-timeout 180 api)
  exit "$code"
}
trap failed EXIT
trap 'exit 1' HUP INT TERM
sed -i "s/^API_RELEASE_TAG=.*/API_RELEASE_TAG=$tag/" "$backend/.local/cloud/cloud.env"
grep -qx "API_RELEASE_TAG=$tag" "$backend/.local/cloud/cloud.env"
(cd "$backend" && sh scripts/cloud.sh --next up -d --no-deps --wait --wait-timeout 180 api)
docker exec -i -e YISHU_SELF_LETTER_SMOKE=1 yishu-cloud-api-1 node --input-type=module < context/scripts/cloud-self-letter-smoke.mjs
docker inspect yishu-cloud-worker-1 yishu-cloud-postgres-1 yishu-cloud-redis-1 yishu-cloud-caddy-1 yishu-cloud-maps-map-tiles-1 yishu-cloud-preview-preview-1 --format '{{.Name}} {{.Image}} {{.State.StartedAt}}' > other-services.after
cmp other-services.before other-services.after
trap - EXIT HUP INT TERM
printf 'SELF_LETTER_POLICY_RELEASE_PASS_OTHER_SERVICES_UNCHANGED\n'

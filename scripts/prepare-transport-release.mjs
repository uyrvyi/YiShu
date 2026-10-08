import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const output = ".local/transport-1.1-20261006-r1";
const sources = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(output, { recursive: false });
async function copy(source, target = source) {
  const content = await readFile(source);
  await mkdir(path.dirname(path.join(output, target)), { recursive: true });
  await writeFile(path.join(output, target), content);
  sources.push({ source, target, sha256: digest(content) });
}
async function tree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".expo"].includes(entry.name)) continue;
    if (
      /(^\.env|\.pem$|\.key$|firebase-adminsdk|fcm-service-account|google-services\.json|^\._|\.DS_Store)/.test(
        entry.name
      )
    )
      throw new Error("unsafe_release_source");
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("release_symlink_forbidden");
    if (entry.isDirectory()) await tree(filename);
    else if (entry.isFile() && !/\.test\.[cm]?[jt]sx?(\.map)?$/.test(entry.name))
      await copy(filename);
  }
}
for (const directory of ["apps/api/dist", "apps/worker/dist", "apps/mobile/app", "apps/mobile/src"])
  await tree(directory);
for (const entry of await readdir("packages", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  await tree(`packages/${entry.name}/dist`);
}
await tree("packages/shared/src");
await copy("packages/shared/package.json");
await copy("apps/mobile/app.json");
await tree("data/graphs/china-v3");
await copy("data/regions/canonical-candidate.json");
await copy("data/maps/district-anchors-1.1-candidate.json");
const registry = JSON.parse(await readFile("data/graphs/registry.json", "utf8"));
assert.deepEqual(registry, { versions: ["china-v1", "china-v2"], defaultVersion: "china-v2" });
await writeFile(
  path.join(output, "data/graphs/registry.json"),
  JSON.stringify(
    {
      versions: [...registry.versions, "china-v3"],
      defaultVersion: "china-v3",
    },
    null,
    2
  ) + "\n"
);
for (const [source, target] of [
  ["deploy/Dockerfile.cloud-transport-1-1", "Dockerfile"],
  ["deploy/release-transport-1-1.sh", "release.sh"],
  ["scripts/cloud-transport-smoke.mjs", "smoke.mjs"],
  ["scripts/check-expo-preview.mjs", "check-expo-preview.mjs"],
  ["deploy/prewarm-national-preview.mjs", "prewarm.mjs"],
  ["docker-compose.cloud.yml", "docker-compose.cloud.yml"],
])
  await copy(source, target);
await writeFile(
  path.join(output, "release-manifest.json"),
  JSON.stringify(
    {
      release: "transport-1.1-20261006-r1",
      decision: "user_requested_deployment_20261006",
      officialMapApproval: "unverified",
      currentBoundaryCertification: "unverified",
      candidateDataSha256: digest(await readFile("data/maps/district-anchors-1.1-candidate.json")),
      graphVersion: "china-v3",
      rulesVersion: "1.1",
      legacyAssetsPreserved: true,
      sources,
    },
    null,
    2
  ) + "\n"
);
const files = [
  "release.sh",
  "smoke.mjs",
  "check-expo-preview.mjs",
  "prewarm.mjs",
  "release-manifest.json",
  "docker-compose.cloud.yml",
];
await writeFile(
  path.join(output, "artifacts.sha256"),
  (
    await Promise.all(
      files.map(async (file) => `${digest(await readFile(path.join(output, file)))}  ${file}`)
    )
  ).join("\n") + "\n"
);
console.log(JSON.stringify({ output, files: sources.length, mapApproval: "unverified" }));

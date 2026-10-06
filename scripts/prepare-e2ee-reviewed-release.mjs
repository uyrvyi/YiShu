import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const output = ".local/e2ee-reviewed-context";
const sources = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function copy(source, target = source) {
  const bytes = await readFile(source);
  await mkdir(path.dirname(path.join(output, target)), { recursive: true });
  await writeFile(path.join(output, target), bytes);
  sources.push({ source, target, sha256: digest(bytes) });
}
async function tree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".expo") continue;
    if (
      /(^\.env|\.pem$|\.key$|firebase-adminsdk|fcm-service-account|google-services\.json|^\._|\.DS_Store)/.test(
        entry.name
      )
    )
      throw new Error("unsafe_release_source");
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await tree(filename);
    else if (entry.isFile() && !/\.test\.(ts|tsx|js)$/.test(entry.name)) await copy(filename);
    else if (entry.isSymbolicLink()) throw new Error("release_symlink_forbidden");
  }
}
await mkdir(output, { recursive: true });
for (const directory of ["apps/api/dist", "apps/mobile/app", "apps/mobile/src"])
  await tree(directory);
await copy("deploy/Dockerfile.cloud-e2ee-reviewed", "Dockerfile");
await copy("deploy/release-e2ee.sh", "release-e2ee.sh");
await copy("scripts/cloud-e2ee-smoke.mjs", "cloud-e2ee-smoke.mjs");
await copy("prisma/migrations/20261005150000_e2ee_envelopes/migration.sql", "migration.sql");
await writeFile(
  path.join(output, "reviewed-sources.json"),
  JSON.stringify({ version: "reviewed-r1", sources }, null, 2) + "\n"
);
const base = await readFile(".local/e2ee-release-20261005/artifacts.sha256", "utf8");
const checks = [base.split("\n").find((line) => line.endsWith("  images.tar.gz"))];
for (const file of [
  "release-e2ee.sh",
  "cloud-e2ee-smoke.mjs",
  "migration.sql",
  "reviewed-sources.json",
])
  checks.push(`${digest(await readFile(path.join(output, file)))}  ${file}`);
await writeFile(path.join(output, "artifacts.sha256"), checks.join("\n") + "\n");

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Build a map-only patch from the exact tested runtime, never the whole checkout.
const root = resolve(import.meta.dirname, "..");
const target = join(root, ".local/cloud-preview/geographic-20261004/context");
const modules = [
  "InteractiveRouteMap.tsx",
  "RouteMap.tsx",
  "layers.tsx",
  "theme.ts",
  "chinaGeographicData.ts",
  "displayProjection.ts",
  "localMapHtml.ts",
  "vendor/leaflet.ts",
  "vendor/LEAFLET_LICENSE",
].map((file) => `apps/mobile/src/map/${file}`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = [];
for (const file of [...modules, "deploy/Dockerfile.cloud-preview-geographic"]) {
  const destination = join(target, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(join(root, file)), { mode: 0o644 });
  sources.push({ file, sha256: sha256(readFileSync(destination)) });
}
const packages = new Map();
function copyPackage(source, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  chmodSync(destination, 0o755);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name),
      to = join(destination, entry.name);
    if (entry.isDirectory()) copyPackage(from, to);
    else if (entry.isFile()) {
      writeFileSync(to, readFileSync(from), { mode: 0o644 });
      chmodSync(to, 0o644);
    } else throw new Error("unexpected_runtime_symlink");
  }
}
function copyRuntime(name, requireFrom) {
  const manifestPath = requireFrom.resolve(`${name}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath));
  if (packages.has(name)) {
    if (packages.get(name).version !== manifest.version)
      throw new Error("runtime_version_conflict");
    return;
  }
  packages.set(name, { version: manifest.version });
  const destination = join(target, "map-runtime", "node_modules", name);
  mkdirSync(dirname(destination), { recursive: true });
  copyPackage(dirname(manifestPath), destination);
  const dependencyRequire = createRequire(manifestPath);
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    copyRuntime(dependency, dependencyRequire);
}
copyRuntime("@turf/projection", createRequire(join(root, "apps/mobile/package.json")));
const manifest = {
  baseImage: "yishu-cloud-preview:preview-20261004-touch-session",
  baseImageId: "sha256:9ee057f5924afec8c9a414e3813ad7bed2f6dc3fab381fb3a7601692351eef2e",
  sources,
  runtime: Object.fromEntries(packages),
  lockSha256: sha256(readFileSync(join(root, "pnpm-lock.yaml"))),
};
writeFileSync(join(target, "geographic-patch.json"), JSON.stringify(manifest, null, 2) + "\n");
const runtimeRequire = createRequire(
  join(target, "map-runtime", "node_modules", "@turf", "projection", "package.json")
);
const { toMercator } = runtimeRequire("./dist/cjs/index.cjs");
const projected = toMercator([121.4737, 31.2304]);
if (!projected.every(Number.isFinite)) throw new Error("runtime_projection_failed");
console.log(JSON.stringify({ target, ...manifest }));

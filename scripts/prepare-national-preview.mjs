import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = join(root, ".local/cloud-preview/national-20261005/context");
const mapFiles = [
  "InteractiveRouteMap.tsx", "localMapHtml.ts", "vectorTiles.ts", "mapDetails.ts",
  "detailLoaders.ts", "vendor/vectorGrid.ts", "vendor/VECTOR_GRID_LICENSES",
  ...readdirSync(join(root, "apps/mobile/src/map/detailData")).map((name) => "detailData/" + name),
].map((file) => "apps/mobile/src/map/" + file);
const files = [...mapFiles, "deploy/Dockerfile.cloud-preview-national", "Dockerfile.map-tiles",
  "scripts/gis/serve_map_tiles.py", "docker-compose.cloud-maps.yml", "docker-compose.cloud-preview.yml",
  "docker-compose.cloud.yml", "deploy/Caddyfile.cloud"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = [];
for (const file of files) {
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
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) copyPackage(from, to);
    else if (entry.isFile()) {
      writeFileSync(to, readFileSync(from), { mode: 0o644 });
      chmodSync(to, 0o644);
    } else throw new Error("unexpected_runtime_symlink");
  }
}
function copyRuntime(name, requireFrom) {
  let packageDirectory = dirname(requireFrom.resolve(name));
  while (!existsSync(join(packageDirectory, "package.json"))) {
    const parent = dirname(packageDirectory);
    if (parent === packageDirectory) throw new Error("runtime_manifest_missing");
    packageDirectory = parent;
  }
  const manifestPath = join(packageDirectory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath));
  if (manifest.name !== name) throw new Error("runtime_manifest_mismatch");
  if (packages.has(name)) {
    if (packages.get(name).version !== manifest.version) throw new Error("runtime_version_conflict");
    return;
  }
  packages.set(name, { version: manifest.version });
  const destination = join(target, "map-runtime", "node_modules", name);
  mkdirSync(dirname(destination), { recursive: true });
  copyPackage(dirname(manifestPath), destination);
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    copyRuntime(dependency, createRequire(manifestPath));
}
const requireMobile = createRequire(join(root, "apps/mobile/package.json"));
for (const name of ["fflate", "topojson-client"]) copyRuntime(name, requireMobile);
const manifest = {
  baseImage: "yishu-cloud-preview:preview-20261004-map-scroll-lock-r2",
  baseImageId: "sha256:f375f740465bc3ff2dfe4a934feafc72aee2b664b05798091221aeb1d7428dbb",
  sources, runtime: Object.fromEntries(packages),
  tileSha256: sha256(readFileSync(join(root, ".local/maps/national-20261003-v2.mbtiles"))),
};
writeFileSync(join(target, "national-patch.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ target, sourceCount: sources.length, runtime: manifest.runtime, tileSha256: manifest.tileSha256 }));

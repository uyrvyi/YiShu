import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const directory = path.join(process.cwd(), "node_modules/.pnpm");
const packages = {};
async function record(filename) {
  const manifest = JSON.parse(await readFile(filename, "utf8"));
  if (manifest.private || !manifest.name || !manifest.version) return;
  packages[manifest.name] ??= [];
  if (!packages[manifest.name].includes(manifest.version))
    packages[manifest.name].push(manifest.version);
}
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "node_modules") continue;
  const modules = path.join(directory, entry.name, "node_modules");
  for (const child of await readdir(modules, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    if (child.name.startsWith("@")) {
      for (const scoped of await readdir(path.join(modules, child.name), { withFileTypes: true })) {
        if (scoped.isDirectory())
          await record(path.join(modules, child.name, scoped.name, "package.json"));
      }
    } else await record(path.join(modules, child.name, "package.json"));
  }
}
console.log(JSON.stringify({ packages }));

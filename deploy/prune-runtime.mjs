import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
assert.equal(process.env.YISHU_RUNTIME_PRUNE, "1", "Use only in the isolated Docker build stage");
const store = path.join(root, "node_modules/.pnpm");
const retained = new Set();

async function locate(name, parent) {
  let directory = parent;
  for (;;) {
    const candidate = path.join(directory, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return realpath(candidate);
    const next = path.dirname(directory);
    if (next === directory) return null;
    directory = next;
  }
}

async function visit(directory) {
  directory = await realpath(directory);
  if (retained.has(directory)) return;
  retained.add(directory);
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...Object.fromEntries(
      Object.entries(manifest.peerDependencies ?? {}).filter(
        ([name]) => !manifest.peerDependenciesMeta?.[name]?.optional
      )
    ),
  };
  for (const name of Object.keys(dependencies)) {
    const dependency = await locate(name, directory);
    if (!dependency) {
      assert.ok(name in (manifest.optionalDependencies ?? {}), `Missing dependency: ${name}`);
      continue;
    }
    await visit(dependency);
  }
}

await visit(path.join(root, "apps/api"));
await visit(path.join(root, "apps/worker"));
// Optional Prisma/TypeScript peers are build tools, not dependencies of the generated client.
let removed = 0;
for (const entry of await readdir(store, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "node_modules") continue;
  const directory = path.join(store, entry.name);
  if ([...retained].some((dependency) => dependency.startsWith(`${directory}/`))) continue;
  await rm(directory, { recursive: true });
  removed++;
}

async function cleanLinks(directory) {
  if (!existsSync(directory)) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.name === ".bin") {
      await rm(filename, { recursive: true });
    } else if (entry.isSymbolicLink()) {
      if (!existsSync(filename)) await rm(filename);
    } else if (entry.isDirectory() && entry.name.startsWith("@")) {
      await cleanLinks(filename);
    }
  }
}
for (const directory of [root, ...retained]) await cleanLinks(path.join(directory, "node_modules"));
await cleanLinks(path.join(store, "node_modules"));
for (const directory of retained) {
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  assert.ok(!["prisma", "typescript", "mysql2", "deepmerge-ts"].includes(manifest.name));
}
// Runtime never installs packages; the repository and build stage retain the frozen lockfile.
for (const filename of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "node_modules/.pnpm/lock.yaml"]) {
  await rm(path.join(root, filename), { force: true });
}
console.log(
  JSON.stringify({ status: "RUNTIME_DEPENDENCIES_PRUNED", retained: retained.size, removed })
);

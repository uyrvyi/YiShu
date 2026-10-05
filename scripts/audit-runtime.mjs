import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const filename = process.argv[2];
assert.ok(filename, "Provide the inventory extracted from the candidate image");
const source = await readFile(filename, "utf8");
const { packages } = JSON.parse(source);
const store = path.resolve("node_modules/.pnpm");
const semverEntry = (await readdir(store)).find((name) => name.startsWith("semver@7."));
assert.ok(semverEntry, "Audit requires the development toolchain's semver 7");
const require = createRequire(import.meta.url);
const semver = require(path.join(store, semverEntry, "node_modules/semver"));
const endpoint = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(packages),
  signal: AbortSignal.timeout(60000),
});
assert.ok(response.ok, "Registry audit unavailable; do not treat this as PASS");
const advisories = await response.json();
const findings = [];
for (const [name, entries] of Object.entries(advisories)) {
  for (const entry of entries) {
    const versions = packages[name].filter((version) =>
      semver.satisfies(version, entry.vulnerable_versions)
    );
    if (versions.length)
      findings.push({
        name,
        versions,
        severity: entry.severity,
        url: entry.url,
        affected: entry.vulnerable_versions,
      });
  }
}
const result = {
  status: findings.length ? "RUNTIME_NPM_AUDIT_FAILED" : "RUNTIME_NPM_AUDIT_PASS",
  capturedAt: new Date().toISOString(),
  inventorySha256: createHash("sha256").update(source).digest("hex"),
  packageNames: Object.keys(packages).length,
  scope: "Installed backend npm packages only; not OS or global toolchain scanning",
  findings,
};
await writeFile(
  ".local/production/runtime-npm-audit.json",
  `${JSON.stringify(result, null, 2)}\n`,
  { mode: 0o600 }
);
console.log(JSON.stringify(result));
process.exitCode = findings.length ? 1 : 0;

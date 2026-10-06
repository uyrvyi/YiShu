import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const bytes = await readFile(new URL("apps/mobile/src/regions/data/pca-current.json", root));
const meta = JSON.parse(await readFile(new URL("apps/mobile/src/regions/data/canonical-regions-meta.json", root)));
const audit = JSON.parse(await readFile(new URL("data/maps/audit/endpoint-release-20261006/summary.json", root)));
const sha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256, meta.outputSha256);
assert.equal(sha256, audit.provenance.regionsSha256);
assert.equal(audit.summary.identityFailures, 0);
assert.deepEqual(audit.summary.officialCountiesMissingFromSelection, []);
assert.deepEqual(audit.summary.selectedCountiesAbsentFromOfficialList, []);
const municipalities = new Set(["11", "12", "31", "50"]);
const regions = JSON.parse(bytes).flatMap((province) => province.children.flatMap((city) =>
  city.children.map((district) => ({
    code: district.code, province: province.name,
    city: municipalities.has(province.code) ? province.name :
      city.name.endsWith("直辖县级行政区划") ? district.name : city.name,
    district: district.name, kind: district.kind ?? "county",
  }))));
assert.equal(regions.length, audit.summary.selectedRegions);
assert.equal(regions.filter((r) => r.kind === "county").length, meta.countyEntries);
assert.equal(regions.filter((r) => r.kind === "city").length, meta.citiesWithoutDistricts);
assert.equal(new Set(regions.map((r) => r.code)).size, regions.length);
assert.equal(new Set(regions.map((r) => [r.province, r.city, r.district].join("/"))).size, regions.length);
assert.ok(regions.every((r) => /^\d{6}$/.test(r.code)));
const directory = new URL("data/regions/", root);
await mkdir(directory, { recursive: true });
const catalog = { revision: meta.revision, selectionSha256: sha256, sourceUrl: meta.sourceUrl,
  sourceSha256: meta.sourceSha256, license: meta.license, status: "candidate", regions };
await writeFile(new URL("canonical-candidate.json", directory), JSON.stringify(catalog) + "\n");
await writeFile(new URL("LCN_LICENSE", directory), await readFile(new URL("apps/mobile/src/regions/data/LCN_LICENSE", root)));
console.log(JSON.stringify({ revision: catalog.revision, regions: regions.length, status: catalog.status }));

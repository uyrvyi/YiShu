import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const commit = "caa859cdce009a4afc72fde0141a0edad7ed26dc";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceUrl = `https://raw.githubusercontent.com/caijf/lcn/${commit}/data/pca.json`;
const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
assert.ok(response.ok, `region_source_http:${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(sha256(bytes), "9e3f9514d5831cda7f73f147943124fc399c6b510c9b38c3072f02bb69c06af2");
const licenseResponse = await fetch(`https://raw.githubusercontent.com/caijf/lcn/${commit}/LICENSE`);
assert.ok(licenseResponse.ok, "region_license_download_failed");
const license = await licenseResponse.text();
assert.ok(license.includes("MIT License"));
const raw = JSON.parse(bytes.toString());
const nonDistrictSanshaCodes = new Set(["460321", "460322", "460323"]);
const removedChongqingCodes = new Set(["500105", "500112"]);
const noDistrictCities = new Set(["441900", "442000", "460400", "620200"]);
const municipalities = new Set(["11", "12", "31", "50"]);
const data = raw.filter((p) => Number(p.code.slice(0, 2)) <= 65).map((province) => ({
  code: province.code.slice(0, 2),
  name: province.name,
  children: province.children.map((city) => {
    const children = (city.children ?? []).filter((district) =>
      !nonDistrictSanshaCodes.has(district.code) && !removedChongqingCodes.has(district.code));
    if (city.code === "500100") children.push({ code: "500157", name: "两江新区" });
    if (noDistrictCities.has(city.code)) {
      assert.equal(children.length, 0);
      children.push({ code: city.code, name: city.name, kind: "city" });
    }
    children.sort((a, b) => a.code.localeCompare(b.code));
    return { code: city.code.slice(0, 4), name: city.name, children };
  }),
}));
assert.equal(data.length, 31);
const entries = data.flatMap((province) => province.children.flatMap((city) =>
  city.children.map((district) => ({ province: province.name,
    city: municipalities.has(province.code) ? province.name :
      city.name.endsWith("直辖县级行政区划") ? district.name : city.name,
    district: district.name, code: district.code, kind: district.kind ?? "county" }))));
assert.equal(entries.filter((entry) => entry.kind === "county").length, 2845);
assert.equal(entries.filter((entry) => entry.kind === "city").length, 4);
assert.equal(new Set(entries.map((entry) => entry.code)).size, entries.length);
assert.ok(entries.every((entry) => /^\d{6}$/.test(entry.code)));
const legacyBytes = await readFile(new URL("apps/mobile/src/regions/data/pca-code.json", root));
assert.equal(sha256(legacyBytes), "83b7536f853ad16beb4d37b92890a3fd7bb9d33d4f37e7c8885fb948749a9bc4");
const selectedKeys = new Set(entries.map((e) => [e.province, e.city, e.district].join("/")));
const retainedLegacy = JSON.parse(legacyBytes).flatMap((p) => p.children.flatMap((c) => c.children.map((d) => ({
  province: p.name,
  city: municipalities.has(p.code) ? p.name : c.name.endsWith("直辖县级行政区划") ? d.name : c.name,
  district: d.name,
  code: d.code,
})))).filter((entry) => !selectedKeys.has([entry.province, entry.city, entry.district].join("/")));
const output = Buffer.from(JSON.stringify(data));
const metadata = {
  revision: "mainland-county-20251231-r1", sourceUrl, commit, sourceSha256: sha256(bytes),
  outputSha256: sha256(output), sourceCutoff: "2024-12-31", changesCutoff: "2025-12-31",
  license: "MIT", provinces: 31, countyEntries: 2845, citiesWithoutDistricts: 4,
  patches: [{ remove: ["500105", "500112"], add: { code: "500157", name: "两江新区" },
    source: "https://mzj.cq.gov.cn/zwgk_218/zfxxgkml/tzgg/202512/t20251205_15215632.html" },
  { remove: ["460321", "460322", "460323"], reason: "statistical island groups are not county-level divisions; retain 西沙区/南沙区" }],
  legacySha256: sha256(legacyBytes), legacyEntriesOutsideCurrentSelection: retainedLegacy,
  compatibility: "Original dataset and saved account/letter addresses remain unchanged. No implicit address conversion.",
  releaseGate: "pending_endpoint_audit",
};
const directory = new URL("apps/mobile/src/regions/data/", root);
await writeFile(new URL("pca-current.json", directory), output);
await writeFile(new URL("canonical-regions-meta.json", directory), JSON.stringify(metadata, null, 2) + "\n");
await writeFile(new URL("LCN_LICENSE", directory), license);
await mkdir(new URL(".local/regions/", root), { recursive: true });
await writeFile(new URL(".local/regions/lcn-source.json", root), bytes);
console.log(JSON.stringify({ revision: metadata.revision, provinces: data.length,
  countyEntries: metadata.countyEntries, cityEntries: 4, excludedLegacy: retainedLegacy.length,
  sha256: metadata.outputSha256, releaseGate: metadata.releaseGate }));

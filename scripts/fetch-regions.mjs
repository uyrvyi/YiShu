import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const commit = "c49d495b40ac73eb1a66f6eeae5f8fd10696f035";
const base = `https://raw.githubusercontent.com/modood/Administrative-divisions-of-China/${commit}`;
const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../apps/mobile/src/regions/data"
);
const response = await fetch(`${base}/dist/pca-code.json`);
if (!response.ok) throw new Error(`region_download_failed:${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const data = JSON.parse(bytes.toString("utf8"));
if (
  !Array.isArray(data) ||
  data.length !== 31 ||
  data.some((province) => !province.name || !province.children?.length)
) {
  throw new Error("invalid_region_dataset");
}
const license = await fetch(`${base}/LICENSE`);
if (!license.ok) throw new Error("region_license_download_failed");
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, "pca-code.json"), bytes);
await writeFile(path.join(directory, "LICENSE"), await license.text());
console.log(
  JSON.stringify({
    commit,
    provinces: data.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })
);

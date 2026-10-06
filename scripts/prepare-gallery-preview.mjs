import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const preload = process.argv.includes("--preload");
const revision = preload ? "gallery-preload-20261005" : "gallery-20261005";
const target = join(root, `.local/cloud-preview/${revision}/context`);
const files = [
  "apps/mobile/app/letters/new.tsx",
  "apps/mobile/app/letters/[trackingNo].tsx",
  "apps/mobile/src/media/ImagePreview.tsx",
  "apps/mobile/src/media/PrivateImage.tsx",
  "apps/mobile/src/media/privateImageCache.ts",
  "apps/mobile/src/map/localMapHtml.ts",
  "deploy/Dockerfile.cloud-preview-gallery",
];
const sources = files.map((file) => {
  const bytes = readFileSync(join(root, file));
  const destination = join(target, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { mode: 0o644 });
  return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
});
const manifest = {
  baseImage: preload
    ? "yishu-cloud-preview:preview-20261005-gallery"
    : "yishu-cloud-preview:preview-20261005-upload-feedback",
  baseImageId: preload
    ? "sha256:1dff0d609b4b1b3a9ba4cf9ed3a34d699919eefaa674bb72d0ad518a0fcb4d26"
    : "sha256:0ccef398af4d9efce6d91cbec148ebce777549877db03aa235bd9d655d250e64",
  sources,
};
writeFileSync(join(target, "gallery-patch.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest));

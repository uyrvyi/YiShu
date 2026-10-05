import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = join(root, ".local/cloud-preview/upload-feedback-20261005/context");
const files = [
  "apps/mobile/app/letters/new.tsx",
  "apps/mobile/src/media/AvatarCropper.tsx",
  "deploy/Dockerfile.cloud-preview-upload-feedback",
];
const sources = files.map((file) => {
  const bytes = readFileSync(join(root, file));
  const destination = join(target, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { mode: 0o644 });
  return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
});
const manifest = {
  baseImage: "yishu-cloud-preview:preview-20261005-national",
  baseImageId: "sha256:2e903d4bd0633c561e6b7ee2aee42eb11e2b8a5e40e8b9ebabb9ee12d88b4f4f",
  sources,
};
writeFileSync(join(target, "upload-feedback-patch.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest));

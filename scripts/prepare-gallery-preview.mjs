import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const preload = process.argv.includes("--preload");
const ritual = process.argv.includes("--ritual");
const paper = process.argv.includes("--paper");
const paperCenter = process.argv.includes("--paper-center");
const sealHold = process.argv.includes("--seal-hold");
const continuousPaper = process.argv.includes("--continuous-paper");
const paperFront = process.argv.includes("--paper-front");
const envelopeGeometry = process.argv.includes("--envelope-geometry");
const paperPreview = process.argv.includes("--paper-preview");
const settle = process.argv.includes("--settle");
const motion = paperPreview || envelopeGeometry || paperFront || continuousPaper || sealHold || paperCenter || paper || ritual || settle || process.argv.includes("--motion");
const revision = paperPreview ? "letter-paper-preview-20261008-r4" : envelopeGeometry ? "letter-envelope-geometry-20261008" : paperFront ? "letter-paper-front-20261008" : continuousPaper ? "letter-continuous-paper-20261008" : sealHold ? "letter-seal-hold-20261007" : paperCenter ? "letter-paper-center-20261007" : paper ? "letter-paper-20261007" : ritual ? "letter-ritual-20261007" : settle ? "gallery-settle-20261007" : motion ? "gallery-motion-20261006" : preload ? "gallery-preload-20261005" : "gallery-20261005";
const target = join(root, `.local/cloud-preview/${revision}/context`);
const files = [
  ...(paperPreview ? [
    "apps/mobile/src/letters/LetterPaper.tsx",
    "apps/mobile/app/letters/[trackingNo].tsx",
    "apps/mobile/app/letters/index.tsx",
    "deploy/Dockerfile.cloud-mobile-patch",
    "deploy/release-gallery-preview.sh",
  ] : envelopeGeometry ? [
    "apps/mobile/src/letters/LetterRitual.tsx",
    "apps/mobile/src/letters/envelopeGeometry.ts",
    "deploy/Dockerfile.cloud-mobile-patch",
    "deploy/release-gallery-preview.sh",
  ] : paperFront ? [
    "apps/mobile/src/letters/LetterRitual.tsx",
    "apps/mobile/src/letters/LetterPaper.tsx",
    "deploy/Dockerfile.cloud-mobile-patch",
    "deploy/release-gallery-preview.sh",
  ] : continuousPaper ? [
    "apps/mobile/src/letters/LetterRitual.tsx",
    "apps/mobile/src/letters/LetterPaper.tsx",
    "apps/mobile/src/letters/ritual.ts",
    "deploy/Dockerfile.cloud-mobile-patch",
    "deploy/release-gallery-preview.sh",
  ] : sealHold ? [
    "apps/mobile/src/letters/LetterRitual.tsx",
    "apps/mobile/src/letters/ritual.ts",
    "deploy/Dockerfile.cloud-mobile-patch",
    "deploy/release-gallery-preview.sh",
  ] : paperCenter ? [
    "apps/mobile/src/letters/LetterPaper.tsx",
    "deploy/Dockerfile.cloud-mobile-patch",
    "deploy/release-gallery-preview.sh",
  ] : paper ? [
    "apps/mobile/app/letters/[trackingNo].tsx",
    "apps/mobile/src/letters/LetterRitual.tsx",
    "apps/mobile/src/letters/LetterPaper.tsx",
    "deploy/Dockerfile.cloud-mobile-patch",
    "deploy/release-gallery-preview.sh",
  ] : ritual ? [
    "apps/mobile/app/letters/new.tsx",
    "apps/mobile/app/letters/[trackingNo].tsx",
    "apps/mobile/src/letters/LetterRitual.tsx",
    "apps/mobile/src/letters/ritual.ts",
    "apps/mobile/src/ui/presentation.ts",
    "deploy/Dockerfile.cloud-mobile-patch",
    "deploy/release-gallery-preview.sh",
  ] : settle ? [
    "apps/mobile/app/letters/new.tsx",
    "apps/mobile/src/media/ImagePreview.tsx",
    "deploy/Dockerfile.cloud-mobile-patch",
    "deploy/release-gallery-preview.sh",
  ] : motion ? [
    "apps/mobile/app/letters/new.tsx",
    "apps/mobile/src/media/ImagePreview.tsx",
    "apps/mobile/src/media/PrivateImage.tsx",
    "apps/mobile/src/media/previewGeometry.ts",
    "deploy/Dockerfile.cloud-mobile-patch",
    "deploy/release-gallery-preview.sh",
  ] : [
  "apps/mobile/app/letters/new.tsx",
  "apps/mobile/app/letters/[trackingNo].tsx",
  "apps/mobile/src/media/ImagePreview.tsx",
  "apps/mobile/src/media/PrivateImage.tsx",
  "apps/mobile/src/media/privateImageCache.ts",
  "apps/mobile/src/map/localMapHtml.ts",
  "deploy/Dockerfile.cloud-preview-gallery",
  ]),
];
const sources = files.map((file) => {
  const bytes = readFileSync(join(root, file));
  const destination = join(target, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { mode: 0o644 });
  return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
});
const manifest = {
  baseImage: paperPreview
    ? "yishu-cloud-preview:preview-20261008-letter-paper-preview-r3"
    : envelopeGeometry
    ? "yishu-cloud-preview:preview-20261008-letter-paper-front-r1"
    : paperFront
    ? "yishu-cloud-preview:preview-20261008-letter-continuous-paper-r1"
    : continuousPaper
    ? "yishu-cloud-preview:preview-20261007-letter-seal-hold-r1"
    : sealHold
    ? "yishu-cloud-preview:preview-20261007-letter-paper-center-r1"
    : paperCenter
    ? "yishu-cloud-preview:preview-20261007-letter-paper-r1"
    : paper
    ? "yishu-cloud-preview:preview-20261007-letter-ritual-r1"
    : ritual
    ? "yishu-cloud-preview:preview-20261007-gallery-settle-r1"
    : settle
    ? "yishu-cloud-preview:preview-20261006-gallery-motion-r1"
    : motion
    ? "yishu-cloud-preview:preview-20261006-transport-1-1-r1"
    : preload
    ? "yishu-cloud-preview:preview-20261005-gallery"
    : "yishu-cloud-preview:preview-20261005-upload-feedback",
  baseImageId: paperPreview
    ? "sha256:9b978c765e35e062034fc386e6a26c84fd74e58d86967d03b6f2bc16f7d0074d"
    : envelopeGeometry
    ? "sha256:19537f3e6602a6471cea75df8279f52ad6d1cdc7def69dda96f68e27a0be3b42"
    : paperFront
    ? "sha256:2eff6aee4e76508b0f11b812cbd660b341d9f4a811de646cab077e466905ad0f"
    : continuousPaper
    ? "sha256:35a4137250c40e14dd6b1ba2066ca98287f6d69478f5bc7d4d6d4d1e7a1da2e0"
    : sealHold
    ? "sha256:6ff85e4ce0b083dcd58d6fdd8157df726af7bbb5b3894c76209a4ad27be8b737"
    : paperCenter
    ? "sha256:024bb2e18ec7c5eb5c6f341d475cceaced1ece0f3bb8967c11db0da909c2b423"
    : paper
    ? "sha256:fc7166ad89bb4a83f309ef0015d3a57a97e326cf5e64a65c7c2e8c60aadbcee6"
    : ritual
    ? "sha256:79b0ec2c69d89b33555ea38c8f959c2593e6b7dd20805db11afab5e4f7907d02"
    : settle
    ? "sha256:b89105d11a3c19cf2230084e55dc886a19578c0e01387c243bea6a3dc5bc23b9"
    : motion
    ? "sha256:c0a5ff2a16acf028d9a2a0d2d4c5fcb42c9c68109f86a60c26038516a1a5d070"
    : preload
    ? "sha256:1dff0d609b4b1b3a9ba4cf9ed3a34d699919eefaa674bb72d0ad518a0fcb4d26"
    : "sha256:0ccef398af4d9efce6d91cbec148ebce777549877db03aa235bd9d655d250e64",
  sources,
};
writeFileSync(join(target, motion ? "e2ee-image-patch.json" : "gallery-patch.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest));

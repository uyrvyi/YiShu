import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const automatic = process.argv.includes("--automatic");
const allPages = process.argv.includes("--keyboard-all");
const keyboard = allPages || process.argv.includes("--keyboard");
const revision = automatic
  ? "automatic-e2ee-20261006"
  : allPages
    ? "keyboard-all-20261005"
    : keyboard
      ? "keyboard-20261005"
      : "e2ee-image-20261005";
const baseImage = automatic
  ? "yishu-cloud-preview:preview-20261005-keyboard-all-r4"
  : allPages
    ? "yishu-cloud-preview:preview-20261005-keyboard-r3"
    : keyboard
      ? "yishu-cloud-preview:preview-20261005-e2ee-image-r2"
      : "yishu-cloud-preview:preview-20261005-e2ee-reviewed-r1";
const baseImageId = automatic
  ? "sha256:6a881f6a31bd0e04050dda7130efa9d3ebd55b66bfe144ce0dec4738fcacc39f"
  : allPages
    ? "sha256:e9431132f40ffba6e69c471314bac11408586d2602070b39ca8ba5d494010961"
    : keyboard
      ? "sha256:e944c36571cf1cc63a016fe097bdb57593151ea945926d758d15d11a066eeffd"
      : "sha256:5292f10249686a831144c2ec763cf38b5659c3b8063dad21eb75bf6b3f591c4c";
const target = join(root, `.local/cloud-preview/${revision}/context`);
const files = [
  ...(automatic
    ? [
        "apps/mobile/app/encryption.tsx",
        "apps/mobile/app/_layout.tsx",
        "apps/mobile/app/letters/new.tsx",
        "apps/mobile/src/ui/controls.tsx",
        "apps/mobile/src/ui/keyboardVisibility.ts",
        "apps/mobile/src/ui/presentation.ts",
        "apps/mobile/src/e2ee/client.ts",
        "apps/mobile/src/e2ee/EncryptionBootstrap.tsx",
      ]
    : allPages
      ? [
          "apps/mobile/app/index.tsx",
          "apps/mobile/app/profile.tsx",
          "apps/mobile/app/encryption.tsx",
          "apps/mobile/app/letters/index.tsx",
          "apps/mobile/app/letters/new.tsx",
          "apps/mobile/src/ui/controls.tsx",
          "apps/mobile/src/regions/RegionSelector.tsx",
        ]
      : [keyboard ? "apps/mobile/app/letters/new.tsx" : "apps/mobile/src/e2ee/client.ts"]),
  automatic
    ? "deploy/Dockerfile.cloud-mobile-patch"
    : allPages
      ? "deploy/Dockerfile.cloud-keyboard"
      : "deploy/Dockerfile.cloud-e2ee-image",
  "deploy/release-e2ee-image-preview.sh",
];
const sources = files.map((file) => {
  const bytes = readFileSync(join(root, file));
  const destination = join(target, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { mode: 0o644 });
  return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
});
writeFileSync(
  join(target, "e2ee-image-patch.json"),
  JSON.stringify(
    {
      baseImage,
      baseImageId,
      sources,
    },
    null,
    2
  ) + "\n"
);

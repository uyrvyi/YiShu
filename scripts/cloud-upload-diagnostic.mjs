import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

assert.equal(process.env.YISHU_UPLOAD_DIAGNOSTIC, "1", "Explicit diagnostic approval required");
const root = process.cwd();
const local = process.env.YISHU_UPLOAD_DIAGNOSTIC_LOCAL === "1";
if (local) assert.equal(process.env.NODE_ENV, "production");
const base = local ? "http://127.0.0.1:4000/api/v1" : "https://8.136.121.71/api/v1";

if (process.argv[2] === "cleanup") {
  assert.equal(process.env.NODE_ENV, "production");
  const database = new URL(process.env.DATABASE_URL);
  assert.equal(database.hostname, "postgres");
  assert.equal(database.pathname, "/yishu");
  const account = process.argv[3];
  assert.match(account ?? "", /^ud[0-9a-f]{16}$/);
  const { createPrismaClient } = await import(`${root}/packages/db/dist/packages/db/src/index.js`);
  const { removeMediaFile } = await import(`${root}/apps/api/dist/lib/media.js`);
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  try {
    const user = await prisma.user.findUnique({ where: { account } });
    if (user) {
      assert.equal(user.nickname, "Upload diagnostic");
      assert.equal(
        await prisma.letter.count({
          where: { OR: [{ senderId: user.id }, { recipientId: user.id }] },
        }),
        0,
        "Diagnostic account unexpectedly has letters; refuse cleanup"
      );
      const assets = await prisma.mediaAsset.findMany({ where: { ownerId: user.id } });
      assert.ok(assets.every((asset) => asset.letterId === null));
      await prisma.mediaAsset.deleteMany({ where: { ownerId: user.id } });
      await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
      for (const asset of assets) await removeMediaFile(process.env.MEDIA_STORAGE_DIR, asset.id);
      console.log(
        JSON.stringify({ status: "UPLOAD_DIAGNOSTIC_CLEANED", account, images: assets.length })
      );
    } else console.log(JSON.stringify({ status: "UPLOAD_DIAGNOSTIC_ALREADY_ABSENT", account }));
  } finally {
    await prisma.$disconnect();
  }
} else {
  const sharp = createRequire(`${root}/apps/api/package.json`)("sharp");
  const account = `ud${randomBytes(8).toString("hex")}`;
  const directory = local
    ? "/tmp/yishu-upload-diagnostic"
    : path.join(root, ".local/cloud-preview/upload-diagnostic");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "account.json"), JSON.stringify({ account }), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ status: "UPLOAD_DIAGNOSTIC_ACCOUNT", account }));
  const started = performance.now();
  const registration = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account,
      password: randomBytes(24).toString("hex"),
      nickname: "Upload diagnostic",
      province: "\u4e0a\u6d77\u5e02",
      city: "\u4e0a\u6d77\u5e02",
      district: "\u5f90\u6c47\u533a",
    }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(registration.status, 201, "Diagnostic registration failed");
  const session = await registration.json();
  console.log(
    JSON.stringify({ status: "REGISTERED", durationMs: Math.round(performance.now() - started) })
  );
  const images = [
    [
      "small",
      await sharp({ create: { width: 24, height: 16, channels: 3, background: "#248860" } })
        .png()
        .toBuffer(),
    ],
    [
      "large",
      await sharp(randomBytes(1280 * 1280 * 3), { raw: { width: 1280, height: 1280, channels: 3 } })
        .png()
        .toBuffer(),
    ],
  ];
  for (const [label, pixels] of images) {
    const form = new FormData();
    form.append("image", new Blob([pixels], { type: "image/png" }), `diagnostic-${label}.png`);
    const start = performance.now();
    const response = await fetch(`${base}/media/images`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    console.log(
      JSON.stringify({
        status: "UPLOAD_RESULT",
        label,
        bytes: pixels.length,
        http: response.status,
        durationMs: Math.round(performance.now() - start),
      })
    );
    assert.equal(response.status, 201, `Diagnostic ${label} upload failed`);
    const { image } = await response.json();
    const readStart = performance.now();
    const preview = await fetch(`${base}/media/${image.id}?size=preview`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
      signal: AbortSignal.timeout(60000),
    });
    const previewBytes = (await preview.arrayBuffer()).byteLength;
    console.log(
      JSON.stringify({
        status: "PREVIEW_RESULT",
        label,
        http: preview.status,
        bytes: previewBytes,
        durationMs: Math.round(performance.now() - readStart),
      })
    );
    assert.equal(preview.status, 200);
  }
  console.log(JSON.stringify({ status: "UPLOAD_DIAGNOSTIC_PASS", account, cleanupRequired: true }));
}

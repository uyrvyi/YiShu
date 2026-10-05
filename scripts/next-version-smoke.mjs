import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createPrismaClient } from "../packages/db/dist/packages/db/src/index.js";
import { requireTestDatabaseUrl } from "../packages/config/dist/index.js";

const databaseUrl = requireTestDatabaseUrl(process.env);
assert.equal(new URL(databaseUrl).hostname, "postgres");
assert.equal(new URL(databaseUrl).pathname, "/yishu_test");
const prisma = createPrismaClient(databaseUrl);
const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
const base = "http://api:4000/api/v1";
const pixels = await sharp({
  create: { width: 24, height: 16, channels: 3, background: "#3a9070" },
})
  .png()
  .toBuffer();
const users = [];
async function request(path, token, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
    },
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  assert.ok(response.ok, `unexpected HTTP ${response.status}: ${path}`);
  return response;
}
async function upload(token, path = "/media/images") {
  const form = new FormData();
  form.append("image", new Blob([pixels], { type: "image/png" }), "photo.png");
  return (await (await request(path, token, "POST", form)).json()).image;
}
try {
  await request("/health");
  for (let i = 0; i < 3; i++) {
    const user = await (
      await request("/auth/register", null, "POST", {
        account: `nv${i}${randomBytes(5).toString("hex")}`,
        password: randomBytes(20).toString("hex"),
        nickname: `Docker smoke ${i}`,
        province: "上海市",
        city: "上海市",
        district: "徐汇区",
      })
    ).json();
    users.push(user);
  }
  const [sender, recipient, third] = users;
  const image = await upload(sender.accessToken);
  const writtenAt = new Date(Date.now() - 3600000).toISOString();
  const payload = {
    recipient: recipient.user.uid,
    content: "private runtime smoke",
    transportType: "HORSE_RELAY",
    imageIds: [image.id],
    writtenAt,
    clientRequestId: randomUUID(),
  };
  const letter = (await (await request("/letters", sender.accessToken, "POST", payload)).json())
    .letter;
  assert.equal(letter.writtenAt, writtenAt);
  assert.equal(letter.images[0].id, image.id);
  const retry = (await (await request("/letters", sender.accessToken, "POST", payload)).json())
    .letter;
  assert.equal(retry.trackingNo, letter.trackingNo);
  const hidden = (
    await (await request(`/letters/${letter.trackingNo}`, recipient.accessToken)).json()
  ).letter;
  assert.equal(hidden.content, null);
  assert.equal(hidden.writtenAt, null);
  assert.deepEqual(hidden.images, []);
  for (const token of [recipient.accessToken, third.accessToken]) {
    assert.equal(
      (await fetch(`${base}/media/${image.id}`, { headers: { authorization: `Bearer ${token}` } }))
        .status,
      404
    );
  }
  const original = await request(`/media/${image.id}`, sender.accessToken);
  assert.equal(original.headers.get("cache-control"), "private, no-store");
  assert.ok(Buffer.from(await original.arrayBuffer()).equals(pixels));
  const preview = await request(`/media/${image.id}?size=preview`, sender.accessToken);
  assert.equal(preview.headers.get("content-type"), "image/webp");
  const profile = (
    await (
      await request("/users/me", recipient.accessToken, "PATCH", {
        nickname: "Edited runtime",
        region: { province: "北京市", city: "北京市", district: "朝阳区" },
      })
    ).json()
  ).user;
  assert.equal(profile.nickname, "Edited runtime");
  const firstAvatar = await upload(sender.accessToken, "/users/me/avatar");
  const secondAvatar = await upload(sender.accessToken, "/users/me/avatar");
  assert.equal(
    (
      await fetch(`${base}/media/${firstAvatar.id}`, {
        headers: { authorization: `Bearer ${sender.accessToken}` },
      })
    ).status,
    404
  );
  await request(`/media/${secondAvatar.id}`, recipient.accessToken);
  // Synthetic status transition tests authorization, not a real delivery or device gate.
  await prisma.letter.update({
    where: { trackingNo: letter.trackingNo },
    data: { status: "DELIVERED", deliveredAt: new Date() },
  });
  const visible = (
    await (await request(`/letters/${letter.trackingNo}`, recipient.accessToken)).json()
  ).letter;
  assert.equal(visible.content, payload.content);
  assert.equal(visible.writtenAt, writtenAt);
  assert.equal(visible.images[0].id, image.id);
  await request(`/media/${image.id}`, recipient.accessToken);
  console.log(
    JSON.stringify({
      status: "NEXT_VERSION_RUNTIME_HTTP_SMOKE_PASS",
      syntheticFixtures: true,
      keptForBackupVerification: process.argv.includes("--keep-fixtures"),
    })
  );
} finally {
  if (!process.argv.includes("--keep-fixtures")) {
    const records = await prisma.user.findMany({
      where: { uid: { in: users.map((entry) => entry.user.uid) } },
    });
    const ids = records.map((entry) => entry.id);
    await prisma.letter.deleteMany({ where: { senderId: { in: ids } } });
    await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}

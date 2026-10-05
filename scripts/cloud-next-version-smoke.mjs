// Run with explicit approval through stdin in the production API container, at /workspace.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

assert.equal(process.env.YISHU_CLOUD_SMOKE, "1", "Explicit cloud smoke opt-in required");
assert.equal(process.env.NODE_ENV, "production");
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, "postgres");
assert.equal(database.pathname, "/yishu");
assert.equal(process.env.MEDIA_STORAGE_DIR, "/media");
const root = process.cwd();
const { createPrismaClient } = await import(`${root}/packages/db/dist/packages/db/src/index.js`);
const { removeMediaFile } = await import(`${root}/apps/api/dist/lib/media.js`);
const sharp = createRequire(`${root}/apps/api/package.json`)("sharp");
const prisma = createPrismaClient(process.env.DATABASE_URL);
const base = "https://8.136.121.71/api/v1";
const accounts = [];
const pixels = await sharp({
  create: { width: 24, height: 16, channels: 3, background: "#248860" },
})
  .png()
  .toBuffer();

async function request(path, token, method = "GET", body, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
    },
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, expected, `Unexpected HTTP status: ${path}`);
  return response;
}

async function upload(token, path = "/media/images") {
  const form = new FormData();
  form.append("image", new Blob([pixels], { type: "image/png" }), "deployment-check.png");
  return (await (await request(path, token, "POST", form, 201)).json()).image;
}

try {
  await request("/health");
  const users = [];
  for (let i = 0; i < 3; i++) {
    const account = `nv${i}${randomBytes(8).toString("hex")}`;
    accounts.push(account);
    users.push(
      await (
        await request(
          "/auth/register",
          null,
          "POST",
          {
            account,
            password: randomBytes(24).toString("hex"),
            nickname: "Deployment check",
            province: "上海市",
            city: "上海市",
            district: "徐汇区",
          },
          201
        )
      ).json()
    );
  }
  const [sender, recipient, third] = users;
  const image = await upload(sender.accessToken);
  const payload = {
    recipient: recipient.user.uid,
    content: "Deployment verification fixture; not a real user letter.",
    transportType: "HORSE_RELAY",
    imageIds: [image.id],
    writtenAt: new Date(Date.now() - 3600000).toISOString(),
    clientRequestId: randomUUID(),
  };
  const letter = (
    await (await request("/letters", sender.accessToken, "POST", payload, 201)).json()
  ).letter;
  assert.equal(letter.writtenAt, payload.writtenAt);
  assert.equal(letter.images[0].id, image.id);
  const hidden = (
    await (await request(`/letters/${letter.trackingNo}`, recipient.accessToken)).json()
  ).letter;
  assert.equal(hidden.content, null);
  assert.equal(hidden.writtenAt, null);
  assert.deepEqual(hidden.images, []);
  for (const token of [recipient.accessToken, third.accessToken]) {
    await request(`/media/${image.id}`, token, "GET", undefined, 404);
  }
  const original = await request(`/media/${image.id}`, sender.accessToken);
  assert.ok(Buffer.from(await original.arrayBuffer()).equals(pixels));
  assert.equal(original.headers.get("cache-control"), "private, no-store");
  const preview = await request(`/media/${image.id}?size=preview`, sender.accessToken);
  assert.equal(preview.headers.get("content-type"), "image/webp");
  const profile = (
    await (
      await request("/users/me", recipient.accessToken, "PATCH", {
        nickname: "Edited deploy check",
        region: { province: "北京市", city: "北京市", district: "朝阳区" },
      })
    ).json()
  ).user;
  assert.equal(profile.nickname, "Edited deploy check");
  const first = await upload(sender.accessToken, "/users/me/avatar");
  const second = await upload(sender.accessToken, "/users/me/avatar");
  await request(`/media/${first.id}`, sender.accessToken, "GET", undefined, 404);
  await request(`/media/${second.id}`, recipient.accessToken);
  console.log(
    JSON.stringify({
      status: "CLOUD_NEXT_VERSION_HTTP_SMOKE_PASS",
      trustedHttps: true,
      fixtureAccountsOnly: true,
      deliveryNotForced: true,
      remotePushNotTested: true,
    })
  );
} finally {
  // Only the unguessable accounts generated in this invocation can be removed.
  const records = await prisma.user.findMany({ where: { account: { in: accounts } } });
  const ids = records.map((record) => record.id);
  const media = await prisma.mediaAsset.findMany({ where: { ownerId: { in: ids } } });
  await prisma.letter.deleteMany({ where: { senderId: { in: ids } } });
  await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: ids } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  for (const asset of media) await removeMediaFile("/media", asset.id);
  await prisma.$disconnect();
  console.log(JSON.stringify({ status: "CLOUD_SMOKE_FIXTURES_REMOVED", accounts: records.length }));
}

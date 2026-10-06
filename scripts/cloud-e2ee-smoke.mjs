// Run through stdin in the production API container with explicit fixture approval.
/* global fetch, FormData, AbortSignal, Blob, structuredClone */
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

assert.equal(process.env.YISHU_E2EE_SMOKE, "1");
assert.equal(process.env.NODE_ENV, "production");
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, "postgres");
assert.equal(database.pathname, "/yishu");
assert.equal(process.env.MEDIA_STORAGE_DIR, "/media");
const root = process.cwd();
const crypto = await import(`${root}/packages/shared/dist/e2ee.js`);
const { createPrismaClient } = await import(`${root}/packages/db/dist/packages/db/src/index.js`);
const { removeMediaFile } = await import(`${root}/apps/api/dist/lib/media.js`);
const { encryptContent } = await import(`${root}/apps/api/dist/lib/crypto.js`);
const { generateTrackingNo } = await import(`${root}/apps/api/dist/lib/trackingNo.js`);
const sharp = createRequire(`${root}/apps/api/package.json`)("sharp");
const db = createPrismaClient(process.env.DATABASE_URL);
const rng = async (n) => new Uint8Array(randomBytes(n));
const accounts = [];
const checks = [];
const base = "https://8.136.121.71/api/v1";
async function counts() {
  return {
    users: await db.user.count(),
    letters: await db.letter.count(),
    media: await db.mediaAsset.count(),
    identities: await db.encryptionIdentity.count(),
  };
}
async function request(path, token, method = "GET", body, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "x-yishu-content-protocol": crypto.E2EE_VERSION,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
    },
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, expected, `Unexpected HTTP status: ${path}`);
  return response;
}
const baseline = await counts();
try {
  await request("/health");
  const users = [];
  for (let i = 0; i < 3; i++) {
    const account = `ee${i}${randomBytes(8).toString("hex")}`;
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
            nickname: "E2EE release fixture",
            province: "上海市",
            city: "上海市",
            district: "黄浦区",
          },
          201
        )
      ).json()
    );
  }
  const [a, b, c] = users;
  // Seed an old-format fixture directly: production must no longer accept new plaintext letters.
  const sender = await db.user.findUniqueOrThrow({ where: { uid: a.user.uid } });
  const recipient = await db.user.findUniqueOrThrow({ where: { uid: b.user.uid } });
  const old = encryptContent("Legacy fixture remains readable", process.env.CONTENT_ENCRYPTION_KEY);
  const legacy = await db.letter.create({
    data: {
      trackingNo: generateTrackingNo(),
      senderId: sender.id,
      recipientId: recipient.id,
      senderAccountSnapshot: sender.account,
      senderUidSnapshot: sender.uid,
      senderNicknameSnapshot: sender.nickname,
      recipientAccountSnapshot: recipient.account,
      recipientUidSnapshot: recipient.uid,
      recipientNicknameSnapshot: recipient.nickname,
      encryptedContent: old.ciphertext,
      contentIv: old.iv,
      contentAuthTag: old.authTag,
      originProvince: sender.province,
      originCity: sender.city,
      originDistrict: sender.district,
      targetProvince: recipient.province,
      targetCity: recipient.city,
      targetDistrict: recipient.district,
      status: "CREATED",
      initialTransport: "HAND_CARRY",
      currentTransport: "HAND_CARRY",
      clientRequestId: randomUUID(),
      requestFingerprint: randomBytes(32).toString("hex"),
      simulationSeed: randomBytes(32).toString("hex"),
    },
  });
  await request("/media/images", a.accessToken, "POST", new FormData(), 409);
  const outdated = await fetch(`${base}/letters`, {
    method: "POST",
    headers: { authorization: `Bearer ${a.accessToken}`, "content-type": "application/json" },
    body: "not-json-from-old-client",
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(outdated.status, 409);
  assert.equal((await outdated.json()).error, "e2ee_required");
  checks.push("production_old_client_and_plaintext_upload_rejected_before_parse");
  const alice = await crypto.createIdentity(a.user.uid, rng);
  const bob = await crypto.createIdentity(b.user.uid, rng);
  const recovery = await crypto.createRecovery(bob, rng);
  for (const [user, record] of [
    [a, (await crypto.createRecovery(alice, rng)).registration],
    [b, recovery.registration],
  ]) {
    await request("/encryption/me", user.accessToken, "POST", record);
  }
  await request("/encryption/me", null, "GET", undefined, 401);
  const pub = await (await request(`/encryption/keys/${b.user.uid}`, a.accessToken)).json();
  assert.deepEqual(pub, { identity: crypto.publicIdentity(bob) });
  assert.ok(!JSON.stringify(pub).includes("backup"));
  const self = await request("/encryption/me", b.accessToken);
  assert.equal(self.headers.get("cache-control"), "private, no-store");
  const restored = crypto.restoreIdentity((await self.json()).registration, recovery.recoveryCode);
  assert.deepEqual(restored, bob);
  assert.throws(() => crypto.restoreIdentity(recovery.registration, "00".repeat(32)));
  const replacement = await crypto.createRecovery(
    await crypto.createIdentity(b.user.uid, rng),
    rng
  );
  await request("/encryption/me", b.accessToken, "POST", replacement.registration, 409);
  await request("/encryption/me", c.accessToken, "POST", recovery.registration, 400);
  checks.push("identity_authentication_backup_recovery_immutable_keys");
  assert.equal(
    (await (await request(`/letters/${legacy.trackingNo}`, a.accessToken)).json()).letter.content,
    "Legacy fixture remains readable"
  );
  for (const user of [a, c]) {
    const response = await request(
      "/letters",
      user.accessToken,
      "POST",
      {
        recipient: b.user.uid,
        content: "No plaintext downgrade",
        transportType: "HAND_CARRY",
        clientRequestId: randomUUID(),
      },
      409
    );
    assert.equal((await response.json()).error, "e2ee_required");
  }
  checks.push("legacy_readability_and_downgrade_denial");
  const pixels = new Uint8Array(
    await sharp({ create: { width: 32, height: 24, channels: 3, background: "#248860" } })
      .png()
      .toBuffer()
  );
  const image = await crypto.encryptImage(pixels, rng);
  const form = new FormData();
  form.append(
    "image",
    new Blob([image.ciphertext], { type: "application/octet-stream" }),
    "fixture.bin"
  );
  const asset = (
    await (await request("/media/encrypted-images", a.accessToken, "POST", form, 201)).json()
  ).image;
  assert.deepEqual(new Uint8Array(await readFile(`/media/${asset.id}.enc`)), image.ciphertext);
  const secret = {
    id: asset.id,
    key: image.key,
    token: image.token,
    digest: image.digest,
    mimeType: "image/png",
    width: 32,
    height: 24,
    byteSize: pixels.length,
  };
  const plaintext = {
    content: `E2EE fixture ${randomUUID()}`,
    writtenAt: new Date().toISOString(),
    images: [secret],
  };
  const requestId = randomUUID();
  const packet = await crypto.encryptLetter(
    alice,
    crypto.publicIdentity(bob),
    plaintext,
    requestId,
    "HAND_CARRY",
    rng
  );
  const wire = {
    recipient: b.user.uid,
    transportType: "HAND_CARRY",
    clientRequestId: requestId,
    imageIds: [asset.id],
    e2ee: packet,
  };
  const created = (await (await request("/letters", a.accessToken, "POST", wire, 201)).json())
    .letter;
  assert.deepEqual(crypto.decryptLetter(alice, created.e2ee), plaintext);
  const stored = await db.letter.findUniqueOrThrow({ where: { trackingNo: created.trackingNo } });
  assert.equal(stored.contentVersion, crypto.E2EE_VERSION);
  assert.equal(stored.encryptedContent, "");
  assert.equal(stored.contentIv, "");
  assert.equal(stored.contentAuthTag, "");
  assert.equal(stored.writtenAt, null);
  for (const sensitive of [plaintext.content, plaintext.writtenAt, secret.key])
    assert.ok(!JSON.stringify(stored.e2ee).includes(sensitive));
  const hidden = (await (await request(`/letters/${created.trackingNo}`, b.accessToken)).json())
    .letter;
  assert.equal(hidden.e2ee, null);
  assert.equal(hidden.content, null);
  assert.equal(hidden.writtenAt, null);
  assert.deepEqual(hidden.images, []);
  const list = await (await request("/letters?direction=received", b.accessToken)).json();
  assert.equal(list.letters.find((item) => item.trackingNo === created.trackingNo).e2ee, null);
  await request(`/letters/${created.trackingNo}`, c.accessToken, "GET", undefined, 404);
  for (const user of [b, c])
    await request(`/media/${asset.id}`, user.accessToken, "GET", undefined, 404);
  await request("/letters", a.accessToken, "POST", wire);
  const changed = structuredClone(wire);
  changed.e2ee.payload.nonce =
    (changed.e2ee.payload.nonce.startsWith("00") ? "01" : "00") +
    changed.e2ee.payload.nonce.slice(2);
  await request("/letters", a.accessToken, "POST", changed, 409);
  changed.clientRequestId = randomUUID();
  await request("/letters", a.accessToken, "POST", changed, 400);
  checks.push("opaque_storage_pre_delivery_visibility_signature_idempotency");
  // Only a letter belonging to these unguessable fixtures can have its delivery status changed.
  const fixtureIds = users.map((user) => user.user.uid);
  assert.ok(
    fixtureIds.includes(stored.senderUidSnapshot) &&
      fixtureIds.includes(stored.recipientUidSnapshot)
  );
  await db.letter.update({
    where: { id: stored.id },
    data: { status: "DELIVERED", deliveredAt: new Date() },
  });
  const delivered = (await (await request(`/letters/${created.trackingNo}`, b.accessToken)).json())
    .letter;
  assert.deepEqual(crypto.decryptLetter(restored, delivered.e2ee), plaintext);
  const media = await request(`/media/${asset.id}`, b.accessToken);
  assert.equal(media.headers.get("cache-control"), "private, no-store");
  assert.equal(media.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(crypto.decryptImage(new Uint8Array(await media.arrayBuffer()), secret), pixels);
  await request(`/media/${asset.id}`, c.accessToken, "GET", undefined, 404);
  const tampered = structuredClone(delivered.e2ee);
  tampered.payload.ciphertext =
    (tampered.payload.ciphertext.startsWith("00") ? "01" : "00") +
    tampered.payload.ciphertext.slice(2);
  assert.throws(() => crypto.decryptLetter(restored, tampered));
  checks.push("post_delivery_decryption_images_tamper_denial");
  console.log(
    JSON.stringify({
      status: "CLOUD_E2EE_HTTP_SMOKE_PASS",
      checks,
      trustedHttps: true,
      realDeviceTest: false,
    })
  );
} finally {
  const records = await db.user.findMany({ where: { account: { in: accounts } } });
  const ids = records.map((user) => user.id);
  const media = await db.mediaAsset.findMany({ where: { ownerId: { in: ids } } });
  await db.letter.deleteMany({ where: { senderId: { in: ids } } });
  await db.mediaAsset.deleteMany({ where: { ownerId: { in: ids } } });
  await db.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  for (const asset of media) await removeMediaFile("/media", asset.id);
  const after = await counts();
  console.log(
    JSON.stringify({ status: "E2EE_FIXTURES_REMOVED", accounts: records.length, baseline, after })
  );
  await db.$disconnect();
}

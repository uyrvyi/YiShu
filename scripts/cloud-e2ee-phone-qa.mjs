// Only generated phone-acceptance fixtures; never enroll endpoint keys on the server.
/* global fetch, AbortSignal */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";

assert.equal(process.env.YISHU_E2EE_PHONE_QA, "1");
assert.equal(process.env.NODE_ENV, "production");
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, "postgres");
assert.equal(database.pathname, "/yishu");
assert.equal(process.env.MEDIA_STORAGE_DIR, "/media");
const root = process.cwd();
const { createPrismaClient } = await import(`${root}/packages/db/dist/packages/db/src/index.js`);
const { removeMediaFile } = await import(`${root}/apps/api/dist/lib/media.js`);
const db = createPrismaClient(process.env.DATABASE_URL);
const action = process.env.YISHU_QA_ACTION;
try {
  if (action === "prepare") {
    for (const label of ["a", "b"]) {
      const account = `eeqa_${label}_${randomBytes(6).toString("hex")}`;
      const password = randomBytes(12).toString("base64url");
      const response = await fetch("https://8.136.121.71/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account,
          password,
          nickname: `E2EE phone QA ${label.toUpperCase()}`,
          province: "上海市",
          city: "上海市",
          district: label === "a" ? "黄浦区" : "浦东新区",
        }),
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(response.status, 201, `QA registration failed: ${label}`);
      const { user } = await response.json();
      // Redirect stdout to a mode-600 file; tokens and private keys are never recorded.
      console.log(JSON.stringify({ label, account, password, uid: user.uid }));
    }
  } else {
    assert.ok(["status", "deliver", "cleanup"].includes(action));
    const accounts = (process.env.YISHU_QA_ACCOUNTS ?? "").split(",");
    assert.equal(accounts.length, 2);
    assert.equal(new Set(accounts).size, 2);
    assert.ok(accounts.every((account) => /^eeqa_[ab]_[a-f0-9]{12}$/.test(account)));
    const users = await db.user.findMany({ where: { account: { in: accounts } } });
    assert.equal(users.length, 2);
    const ids = users.map((user) => user.id);
    const letters = await db.letter.findMany({
      where: { OR: [{ senderId: { in: ids } }, { recipientId: { in: ids } }] },
    });
    assert.ok(
      letters.every((letter) => ids.includes(letter.senderId) && ids.includes(letter.recipientId))
    );
    if (action === "deliver") {
      const letter = letters.find((item) => item.trackingNo === process.env.YISHU_QA_TRACKING);
      assert.ok(letter, "Only a letter between the two approved QA accounts may be delivered");
      assert.equal(letter.contentVersion, "yishu-e2ee-v1");
      assert.notEqual(letter.status, "DELIVERED");
      await db.letter.update({
        where: { id: letter.id },
        data: { status: "DELIVERED", deliveredAt: new Date() },
      });
      console.log(JSON.stringify({ status: "QA_LETTER_DELIVERED", trackingNo: letter.trackingNo }));
    } else if (action === "cleanup") {
      const media = await db.mediaAsset.findMany({ where: { ownerId: { in: ids } } });
      await db.$transaction(async (tx) => {
        await tx.letter.deleteMany({ where: { senderId: { in: ids } } });
        await tx.mediaAsset.deleteMany({ where: { ownerId: { in: ids } } });
        await tx.user.deleteMany({ where: { id: { in: ids } } });
      });
      for (const asset of media) await removeMediaFile("/media", asset.id);
      assert.equal(await db.user.count({ where: { id: { in: ids } } }), 0);
      console.log(
        JSON.stringify({
          status: "PHONE_QA_FIXTURES_REMOVED",
          users: 2,
          letters: letters.length,
          media: media.length,
        })
      );
    } else {
      console.log(
        JSON.stringify({
          status: "PHONE_QA_STATE",
          users: users.map(({ uid, account }) => ({ uid, account })),
          identities: await db.encryptionIdentity.count({ where: { userId: { in: ids } } }),
          letters: letters.map(({ trackingNo, status, contentVersion }) => ({
            trackingNo,
            status,
            contentVersion,
          })),
          media: await db.mediaAsset.count({ where: { ownerId: { in: ids } } }),
        })
      );
    }
  }
} finally {
  await db.$disconnect();
}

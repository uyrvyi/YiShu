import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
const { createPrismaClient } = await import(`${process.cwd()}/packages/db/dist/packages/db/src/index.js`);
assert.equal(process.env.NODE_ENV, "production");
assert.equal(process.env.YISHU_SELF_LETTER_SMOKE, "1");
const db = createPrismaClient(process.env.DATABASE_URL);
try {
  const user = await db.user.findUnique({ where: { account: "rq_1007_8ae4f112" } });
  assert.ok(user, "Generated acceptance account required");
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.uid, exp: Math.floor(Date.now() / 1000) + 60 })}`;
  const token = `${input}.${createHmac("sha256", process.env.JWT_SECRET).update(input).digest("base64url")}`;
  const requestId = "ritual-self-policy-negative-20261007";
  assert.equal(await db.letter.count({ where: { clientRequestId: requestId } }), 0);
  for (const recipient of [user.uid, user.account.toUpperCase()]) {
    const response = await fetch("https://8.136.121.71/api/v1/letters", {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-yishu-content-protocol": "yishu-e2ee-v1" },
      body: JSON.stringify({ recipient, content: "Generated negative test", transportType: "HORSE_RELAY", clientRequestId: requestId }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "cannot_send_to_self");
  }
  assert.equal(await db.letter.count({ where: { clientRequestId: requestId } }), 0);
  console.log("SELF_SEND_PUBLIC_HTTPS_ACCOUNT_AND_UID_REJECTED_PASS");
} finally { await db.$disconnect(); }

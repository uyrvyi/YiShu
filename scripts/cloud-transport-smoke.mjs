import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

assert.equal(process.env.YISHU_TRANSPORT_SMOKE, "1");
assert.equal(process.env.NEW_LETTER_RULES_VERSION, "1.1");
const root = process.cwd();
const crypto = await import(`${root}/packages/shared/dist/e2ee.js`);
const { createPrismaClient } = await import(`${root}/packages/db/dist/packages/db/src/index.js`);
const { advanceJourneyToNow } = await import(`${root}/packages/domain/dist/index.js`);
const { TestSimulationClock } = await import(`${root}/packages/simulation/dist/index.js`);
const registry = JSON.parse(await readFile(`${root}/data/graphs/registry.json`, "utf8"));
assert.equal(registry.defaultVersion, "china-v3");
const db = createPrismaClient(process.env.DATABASE_URL);
const rng = async (n) => new Uint8Array(randomBytes(n));
const accounts = [];
const base = "https://8.136.121.71/api/v1";
const HOUR = 3600000;
const origin = { province: "上海市", city: "上海市", district: "黄浦区" };
const local = { ...origin, district: "浦东新区" };
const distant = { province: "浙江省", city: "杭州市", district: "余杭区" };
async function request(url, token, method = "GET", payload, status = 200) {
  const response = await fetch(base + url, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: {
      "x-yishu-content-protocol": crypto.E2EE_VERSION,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  assert.ok((Array.isArray(status) ? status : [status]).includes(response.status), `${method} ${url}: HTTP ${response.status}`);
  return response.json();
}
const baseline = {
  users: await db.user.count(),
  letters: await db.letter.count(),
  identities: await db.encryptionIdentity.count(),
};
try {
  const users = [];
  for (const region of [origin, local]) {
    const account = `trqa_${randomBytes(9).toString("hex")}`;
    accounts.push(account);
    const user = await request(
      "/auth/register",
      null,
      "POST",
      {
        account,
        password: randomBytes(24).toString("hex"),
        nickname: "transport release QA",
        ...region,
      },
      201
    );
    const key = await crypto.createIdentity(user.user.uid, rng);
    await request(
      "/encryption/me",
      user.accessToken,
      "POST",
      (await crypto.createRecovery(key, rng)).registration
    );
    users.push({ ...user, key });
  }
  const [a, b] = users;
  const map = (no, user = a) => request(`/letters/${no}/map`, user.accessToken);
  async function send() {
    const requestId = randomUUID();
    const plain = {
      content: "transport encrypted fixture",
      writtenAt: new Date().toISOString(),
      images: [],
    };
    const envelope = await crypto.encryptLetter(
      a.key,
      crypto.publicIdentity(b.key),
      plain,
      requestId,
      "PIGEON",
      rng
    );
    const created = await request(
      "/letters",
      a.accessToken,
      "POST",
      {
        recipient: b.user.uid,
        transportType: "PIGEON",
        clientRequestId: requestId,
        imageIds: [],
        e2ee: envelope,
      },
      201
    );
    const letter = await db.letter.findUniqueOrThrow({
      where: { trackingNo: created.letter.trackingNo },
    });
    assert.equal(letter.rulesVersion, "1.1");
    assert.equal(letter.graphVersion, "china-v3");
    await request(
      `/letters/${letter.trackingNo}/journey`,
      a.accessToken,
      "POST",
      {},
      [200, 201]
    );
    assert.deepEqual(crypto.decryptLetter(a.key, created.letter.e2ee), plain);
    return { letter, plain };
  }
  const { letter, plain } = await send();
  const start = (letter.sentAt ?? letter.createdAt).getTime();
  const sent = await map(letter.trackingNo);
  assert.equal(sent.collection.from.district, origin.district);
  assert.equal(sent.collection.to.city, origin.city);
  assert.equal(sent.delivery.to.district, local.district);
  assert.deepEqual(sent.districtLocationsUnavailable, []);
  for (const connection of [sent.collection, sent.delivery])
    assert.ok(
      Math.max(
        Math.abs(connection.from.x - connection.to.x),
        Math.abs(connection.from.y - connection.to.y)
      ) >= 0.000002
    );
  const hidden = await request(`/letters/${letter.trackingNo}`, b.accessToken);
  assert.equal(hidden.letter.e2ee, null);
  assert.equal((await map(letter.trackingNo, b)).delivery, null);
  await advanceJourneyToNow(db, letter.id, new TestSimulationClock(start + 3 * HOUR));
  assert.equal(
    (await db.letter.findUniqueOrThrow({ where: { id: letter.id } })).status,
    "OUT_FOR_DELIVERY"
  );
  await advanceJourneyToNow(db, letter.id, new TestSimulationClock(start + 9 * HOUR));
  const delivered = await db.letter.findUniqueOrThrow({ where: { id: letter.id } });
  assert.equal(delivered.deliveredAt.getTime(), start + 9 * HOUR);
  const received = await request(`/letters/${letter.trackingNo}`, b.accessToken);
  assert.deepEqual(crypto.decryptLetter(b.key, received.letter.e2ee), plain);
  await request("/users/me", b.accessToken, "PATCH", { region: distant });
  assert.equal(
    (await db.letter.findUniqueOrThrow({ where: { id: letter.id } })).targetDistrict,
    local.district
  );
  const second = (await send()).letter;
  const planned = await map(second.trackingNo);
  assert.equal(planned.delivery.from.city, distant.city);
  assert.equal(planned.delivery.to.district, distant.district);
  assert.equal(planned.collection.from.district, origin.district);
  const journey = await db.journey.findUniqueOrThrow({
    where: { letterId: second.id },
    include: { legs: true },
  });
  assert.ok(journey.legs.length > 0);
  assert.ok(journey.legs.every((leg) => leg.startedAtSim === null));
  assert.deepEqual((await map(second.trackingNo, b)).remainingPath, []);
  console.log(
    JSON.stringify({
      status: "TRANSPORT_1_1_HTTPS_E2EE_SMOKE_PASS",
      sameCityHours: 9,
      crossCityDistrictSegments: true,
      globalClockChanged: false,
      realDeviceTest: false,
    })
  );
} finally {
  const records = await db.user.findMany({ where: { account: { in: accounts } } });
  const ids = records.map((user) => user.id);
  await db.letter.deleteMany({ where: { senderId: { in: ids } } });
  await db.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  console.log(
    JSON.stringify({
      status: "TRANSPORT_FIXTURES_REMOVED",
      accounts: records.length,
      baseline,
      after: {
        users: await db.user.count(),
        letters: await db.letter.count(),
        identities: await db.encryptionIdentity.count(),
      },
    })
  );
  await db.$disconnect();
}

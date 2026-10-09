import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

assert.equal(process.env.NODE_ENV, "production");
assert.equal(process.env.YISHU_TIMELINE_DISPLAY_SMOKE, "1");
const { createPrismaClient } = await import(`${process.cwd()}/packages/db/dist/packages/db/src/index.js`);
const db = createPrismaClient(process.env.DATABASE_URL);
try {
  const trackingNo = "YS-20261003-AU5X1";
  const letter = await db.letter.findUniqueOrThrow({
    where: { trackingNo },
    select: { id: true, sender: { select: { uid: true } }, recipient: { select: { uid: true } },
      journey: { select: { worldEvents: { orderBy: { eventIndex: "asc" } } } } },
  });
  const missing = letter.journey.worldEvents.find((event) => event.eventType === "COURIER_MISSING");
  assert.ok(missing);
  const oldArrivalKey = `leg:${missing.transportLegSequence}:arrived`;
  const before = await db.timelineEvent.findUniqueOrThrow({
    where: { letterId_sourceKey: { letterId: letter.id, sourceKey: oldArrivalKey } },
  });
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  let expected;
  for (const user of [letter.sender, letter.recipient]) {
    const input = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.uid, exp: Math.floor(Date.now() / 1000) + 60 })}`;
    const token = `${input}.${createHmac("sha256", process.env.JWT_SECRET).update(input).digest("base64url")}`;
    const response = await fetch(`https://8.136.121.71/api/v1/letters/${trackingNo}/timeline`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200);
    const { timeline } = await response.json();
    assert.ok(timeline.some((event) => event.type === "COURIER_MISSING"));
    assert.ok(!timeline.some((event) => event.type === "ARRIVED_STATION" && event.happenedAt === missing.occurredAtSim.toISOString()));
    assert.ok(!JSON.stringify(timeline).match(/LOST_PATH|recoveryWindow|cause/));
    if (expected) assert.deepEqual(timeline, expected); else expected = timeline;
  }
  assert.deepEqual(await db.timelineEvent.findUniqueOrThrow({
    where: { letterId_sourceKey: { letterId: letter.id, sourceKey: oldArrivalKey } },
  }), before);
  assert.deepEqual(await db.worldEvent.findMany({
    where: { journey: { letterId: letter.id } }, orderBy: { eventIndex: "asc" },
  }), letter.journey.worldEvents);
  console.log("AU5X1_PUBLIC_TIMELINE_BOTH_PARTICIPANTS_PASS_LEGACY_AND_WORLD_EVENTS_PRESERVED");
} finally { await db.$disconnect(); }

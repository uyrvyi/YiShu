import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { deterministicDraw, TestSimulationClock } from "@yishu/simulation";
import { advanceJourneyToNow } from "@yishu/domain";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

function normalPigeonSeed(): string {
  for (let i = 0; i < 20000; i++) {
    const seed = `phase10-normal-${i}`;
    if (
      Array.from({ length: 40 }, (_, draw) => deterministicDraw(seed, draw)).every((n) => n < 0.92)
    )
      return seed;
  }
  throw new Error("normal_seed_unavailable");
}

describe("Phase 10 mobile contract", () => {
  let app: FastifyInstance;
  let db: PrismaClient;
  let clock: TestSimulationClock;

  beforeAll(async () => {
    db = createPrismaClient(requireTestDatabaseUrl(process.env));
    clock = new TestSimulationClock(Date.now());
    app = buildApp(loadConfig({ NODE_ENV: "test" }), { prisma: db, simulationClock: clock });
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it("注册、登录、精准搜索、寄送、收信、拆信、地图和双方独立隐藏", async () => {
    const suffix = randomUUID().slice(0, 8);
    const register = async (account: string, city: string, district: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          account,
          password: "phase10-pass",
          nickname: account,
          province: city,
          city,
          district,
        },
      });
      expect(res.statusCode).toBe(201);
      return res.json() as { user: { uid: string }; accessToken: string };
    };
    await register(`p10a${suffix}`, "上海市", "徐汇区");
    const bob = await register(`p10b${suffix}`, "北京市", "海淀区");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { account: `p10a${suffix}`, password: "phase10-pass" },
    });
    expect(login.statusCode).toBe(200);
    const senderToken = (login.json() as { accessToken: string }).accessToken;
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });

    const search = await app.inject({
      method: "GET",
      url: `/api/v1/users/search?q=${bob.user.uid}`,
      headers: auth(senderToken),
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().uid).toBe(bob.user.uid);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: auth(senderToken),
      payload: {
        recipient: bob.user.uid,
        content: "只给收件人的正文",
        transportType: "PIGEON",
        clientRequestId: `phase10-${suffix}`,
      },
    });
    expect(created.statusCode).toBe(201);
    const trackingNo: string = created.json().letter.trackingNo;
    const path = `/api/v1/letters/${trackingNo}`;
    const initial = await app.inject({
      method: "POST",
      url: `${path}/journey`,
      headers: auth(senderToken),
    });
    expect(initial.statusCode).toBe(201);
    expect(
      (await app.inject({ method: "POST", url: `${path}/journey`, headers: auth(senderToken) }))
        .statusCode
    ).toBe(200);

    const before = await app.inject({ method: "GET", url: path, headers: auth(bob.accessToken) });
    expect(before.json().letter.content).toBeNull();
    expect(
      (await app.inject({ method: "POST", url: `${path}/open`, headers: auth(bob.accessToken) }))
        .statusCode
    ).toBe(409);
    const row = await db.letter.findUniqueOrThrow({ where: { trackingNo } });
    await db.journey.update({
      where: { letterId: row.id },
      data: { simulationSeed: normalPigeonSeed() },
    });
    await advanceJourneyToNow(db, row.id, clock);
    clock.advanceBy(40 * 86400000);
    await advanceJourneyToNow(db, row.id, clock);

    const sender = (
      await app.inject({ method: "GET", url: path, headers: auth(senderToken) })
    ).json().letter;
    const recipient = (
      await app.inject({ method: "GET", url: path, headers: auth(bob.accessToken) })
    ).json().letter;
    expect(sender.status).toBe("DELIVERED");
    expect(recipient.status).toBe("DELIVERED");
    expect("readState" in sender).toBe(false);
    expect(recipient.content).toBe("只给收件人的正文");
    expect(recipient.readState).toBe("UNOPENED");
    expect(
      (await app.inject({ method: "POST", url: `${path}/open`, headers: auth(bob.accessToken) }))
        .statusCode
    ).toBe(200);

    const senderTimeline = (
      await app.inject({ method: "GET", url: `${path}/timeline`, headers: auth(senderToken) })
    ).json().timeline;
    const recipientTimeline = (
      await app.inject({ method: "GET", url: `${path}/timeline`, headers: auth(bob.accessToken) })
    ).json().timeline;
    expect(senderTimeline).toEqual(recipientTimeline);
    expect(senderTimeline.some((event: { type: string }) => event.type === "DELIVERED")).toBe(true);
    const map = (
      await app.inject({ method: "GET", url: `${path}/map`, headers: auth(bob.accessToken) })
    ).json();
    expect(map.status).toBe(recipient.status);
    expect(JSON.stringify({ sender, recipient, map, senderTimeline })).not.toMatch(
      /etaSeconds|simulationSeed|LETTER_DROPPED|encryptedContent|worldEvents/i
    );

    expect(
      (await app.inject({ method: "POST", url: `${path}/hide`, headers: auth(senderToken) }))
        .statusCode
    ).toBe(200);
    const sentList = (
      await app.inject({
        method: "GET",
        url: "/api/v1/letters?direction=sent",
        headers: auth(senderToken),
      })
    ).json().letters as Array<{ trackingNo: string }>;
    const receivedList = (
      await app.inject({
        method: "GET",
        url: "/api/v1/letters?direction=received",
        headers: auth(bob.accessToken),
      })
    ).json().letters as Array<{ trackingNo: string }>;
    expect(sentList.some((letter) => letter.trackingNo === trackingNo)).toBe(false);
    expect(receivedList.some((letter) => letter.trackingNo === trackingNo)).toBe(true);
    expect(
      (await app.inject({ method: "POST", url: `${path}/hide`, headers: auth(bob.accessToken) }))
        .statusCode
    ).toBe(200);
  });
});

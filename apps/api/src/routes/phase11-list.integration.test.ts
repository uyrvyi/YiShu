import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

describe("Phase 11 visible list pagination", () => {
  let app: FastifyInstance;
  let db: PrismaClient;
  const accounts = [0, 1].map((i) => `p11list${i}${randomUUID().slice(0, 8)}`);
  const users: Array<{ id: bigint; uid: string; token: string }> = [];

  beforeAll(async () => {
    db = createPrismaClient(requireTestDatabaseUrl(process.env));
    app = buildApp(loadConfig({ NODE_ENV: "test" }), { prisma: db });
    for (const account of accounts) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          account,
          password: "phase11-password",
          nickname: "List",
          province: "上海市",
          city: "上海市",
          district: "徐汇区",
        },
      });
      expect(response.statusCode).toBe(201);
      const row = await db.user.findUniqueOrThrow({ where: { account } });
      users.push({ id: row.id, uid: row.uid, token: response.json().accessToken });
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      await db.letter.deleteMany({ where: { sender: { account: { in: accounts } } } });
      await db.refreshToken.deleteMany({ where: { user: { account: { in: accounts } } } });
      await db.user.deleteMany({ where: { account: { in: accounts } } });
      await db.$disconnect();
    }
  });

  async function create(
    senderIndex: number,
    recipientIndex: number,
    hidden: boolean,
    createdAt: Date
  ) {
    const sender = users[senderIndex];
    const recipient = users[recipientIndex];
    if (!sender || !recipient) throw new Error("missing_fixture_user");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: { authorization: `Bearer ${sender.token}` },
      payload: {
        recipient: recipient.uid,
        content: "visible list",
        transportType: "PIGEON",
        clientRequestId: randomUUID(),
      },
    });
    expect(response.statusCode).toBe(201);
    const trackingNo: string = response.json().letter.trackingNo;
    await db.letter.update({
      where: { trackingNo },
      data: {
        createdAt,
        senderState: { update: { hiddenAt: hidden ? new Date() : null } },
        recipientState: { update: { hiddenAt: hidden ? new Date() : null } },
      },
    });
    return trackingNo;
  }

  async function list(index: number, direction: string) {
    const user = users[index];
    if (!user) throw new Error("missing_fixture_user");
    const response = await app.inject({
      url: `/api/v1/letters?limit=1${direction}`,
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(response.statusCode).toBe(200);
    return (response.json().letters as Array<{ trackingNo: string }>).map(
      (letter) => letter.trackingNo
    );
  }

  it("filters hidden rows before limit for sent, received and combined lists", async () => {
    const visible = await create(0, 1, false, new Date("2026-01-01"));
    await create(0, 1, true, new Date("2026-01-02"));
    expect(await list(0, "&direction=sent")).toEqual([visible]);
    expect(await list(1, "&direction=received")).toEqual([visible]);
    expect(await list(0, "")).toEqual([visible]);
    expect(await list(1, "")).toEqual([visible]);
  });

  it("keeps the sender-view precedence for a letter sent to self", async () => {
    const trackingNo = await create(0, 0, false, new Date("2026-02-01"));
    await db.letter.update({
      where: { trackingNo },
      data: { recipientState: { update: { hiddenAt: new Date() } } },
    });
    expect(await list(0, "&direction=received")).toEqual([trackingNo]);
    await db.letter.update({
      where: { trackingNo },
      data: { senderState: { update: { hiddenAt: new Date() } } },
    });
    expect(await list(0, "&direction=received")).toEqual([]);
  });
});

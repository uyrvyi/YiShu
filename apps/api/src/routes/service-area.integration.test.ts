import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

const available = { province: "上海市", city: "上海市", district: "徐汇区" };
const kinmen = { province: "福建省", city: "泉州市", district: "金门县" };
const sansha = { province: "海南省", city: "三沙市", district: "南沙区" };
const unavailable = [
  { province: "香港特别行政区", city: "香港", district: "中西区" },
  { province: "澳門特別行政區", city: "澳門", district: "花地瑪堂區" },
  { province: "台湾省", city: "台北市", district: "中正区" },
  { province: "710000", city: "台北市", district: "中正区" },
  { province: "香港特別行政区", city: "香港", district: "中西区" },
  { province: "福建省", city: "泉州市", district: "金門县" },
  kinmen,
  sansha,
  { ...sansha, district: "南沙區" },
  { ...sansha, district: "南沙群岛" },
];

describe("service coverage enforcement without changing historical letters", () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let sender: { id: bigint; uid: string; account: string; token: string };
  let recipient: typeof sender;
  const suffix = Math.random().toString(36).slice(2, 8);
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const registration = (account: string, region = available) =>
    app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { account, password: "service-test-password", nickname: account, ...region },
    });
  const payload = () => ({
    recipient: recipient.uid,
    content: "historical private body",
    transportType: "HORSE_RELAY",
    clientRequestId: "coverage-letter",
  });
  const send = () =>
    app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: auth(sender.token),
      payload: payload(),
    });

  beforeAll(async () => {
    prisma = createPrismaClient(requireTestDatabaseUrl(process.env));
    app = buildApp(loadConfig({ NODE_ENV: "test" }), { prisma });
    async function register(prefix: string) {
      const account = prefix + suffix;
      const result = await registration(account);
      expect(result.statusCode).toBe(201);
      const uid = result.json().user.uid as string;
      const user = await prisma.user.findUniqueOrThrow({ where: { uid } });
      return { id: user.id, uid, account, token: result.json().accessToken as string };
    }
    sender = await register("cas");
    recipient = await register("car");
  });
  beforeEach(async () => {
    await prisma.letter.deleteMany({ where: { senderId: sender.id } });
    await prisma.user.updateMany({
      where: { id: { in: [sender.id, recipient.id] } },
      data: available,
    });
  });
  afterAll(async () => {
    if (app) await app.close();
    const ids = [sender?.id, recipient?.id].filter((id): id is bigint => id !== undefined);
    if (prisma) {
      await prisma.letter.deleteMany({ where: { senderId: { in: ids } } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      await prisma.$disconnect();
    }
  });

  it.each(unavailable)(
    "rejects registration in $province/$district without creating an account",
    async (region) => {
      const account = "denied" + suffix;
      try {
        const response = await registration(account, region);
        expect(response.statusCode).toBe(422);
        expect(response.json()).toEqual({ error: "region_service_unavailable" });
        expect(await prisma.user.findUnique({ where: { account } })).toBeNull();
      } finally {
        const user = await prisma.user.findUnique({ where: { account } });
        if (user) {
          await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
          await prisma.user.delete({ where: { id: user.id } });
        }
      }
    }
  );
  it.each([
    { ...kinmen, district: "金門县" },
    { province: "香港特別行政区", city: "香港", district: "中西区" },
    sansha,
  ])(
    "rejects mixed-script region edits without an existing letter: $province/$district",
    async (region) => {
      const before = await prisma.user.findUniqueOrThrow({ where: { id: recipient.id } });
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/users/me",
        headers: auth(recipient.token),
        payload: { nickname: "must not persist", region },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toBe("region_service_unavailable");
      expect(await prisma.user.findUniqueOrThrow({ where: { id: recipient.id } })).toEqual(before);
    }
  );
  it.each([kinmen, { ...kinmen, district: "金門县" }, sansha])(
    "rejects a destination change atomically before touching an old letter: $district",
    async (region) => {
      expect((await send()).statusCode).toBe(201);
      const before = await prisma.letter.findFirstOrThrow({ where: { senderId: sender.id } });
      const beforeUser = await prisma.user.findUniqueOrThrow({ where: { id: recipient.id } });
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/users/me",
        headers: auth(recipient.token),
        payload: { nickname: "must roll back", region },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toBe("region_service_unavailable");
      expect(await prisma.user.findUniqueOrThrow({ where: { id: recipient.id } })).toEqual(
        beforeUser
      );
      expect(await prisma.letter.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
      expect(await prisma.journey.count({ where: { letterId: before.id } })).toBe(0);
    }
  );
  it.each([
    { side: "sender", region: kinmen },
    { side: "recipient", region: kinmen },
    { side: "sender", region: sansha },
    { side: "recipient", region: sansha },
  ] as const)(
    "blocks new letters involving an existing unavailable $side in $region.city",
    async ({ side, region }) => {
      await prisma.user.update({
        where: { id: side === "sender" ? sender.id : recipient.id },
        data: region,
      });
      expect((await send()).statusCode).toBe(422);
      expect(await prisma.letter.count({ where: { senderId: sender.id } })).toBe(0);
      const estimate = await app.inject({
        method: "POST",
        url: "/api/v1/transport-estimates",
        headers: auth(sender.token),
        payload: { recipient: recipient.uid },
      });
      expect(estimate.statusCode).toBe(422);
      expect(estimate.json().error).toBe("region_service_unavailable");
    }
  );
  it("allows registration in Guangzhou Nansha and other Hainan districts", async () => {
    for (const [index, region] of [
      { province: "广东省", city: "广州市", district: "南沙区" },
      { ...sansha, district: "西沙区" },
    ].entries()) {
      const account = `allowed${index}${suffix}`;
      try {
        expect((await registration(account, region)).statusCode).toBe(201);
      } finally {
        const user = await prisma.user.findUnique({ where: { account } });
        if (user) {
          await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
          await prisma.user.delete({ where: { id: user.id } });
        }
      }
    }
  });
  it.each([kinmen, sansha])(
    "allows old account login, nickname edits, moving out, and an existing letter retry in $city",
    async (region) => {
      const sent = await send();
      expect(sent.statusCode).toBe(201);
      const before = await prisma.letter.findFirstOrThrow({ where: { senderId: sender.id } });
      await prisma.user.update({ where: { id: recipient.id }, data: region });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { account: recipient.account, password: "service-test-password" },
      });
      expect(login.statusCode).toBe(200);
      const edit = await app.inject({
        method: "PATCH",
        url: "/api/v1/users/me",
        headers: auth(recipient.token),
        payload: { nickname: "existing user" },
      });
      expect(edit.statusCode).toBe(200);
      const retry = await send();
      expect(retry.statusCode).toBe(200);
      expect(retry.json().letter.trackingNo).toBe(sent.json().letter.trackingNo);
      const read = await app.inject({
        method: "GET",
        url: `/api/v1/letters/${before.trackingNo}`,
        headers: auth(recipient.token),
      });
      expect(read.statusCode).toBe(200);
      expect(await prisma.letter.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
      const move = await app.inject({
        method: "PATCH",
        url: "/api/v1/users/me",
        headers: auth(recipient.token),
        payload: { region: available },
      });
      expect(move.statusCode).toBe(200);
    }
  );
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";
import { DELIVERED } from "../lib/letter-view.js";

/**
 * Phase 3 Letter 集成测试（仅 *_test 库）。
 */
describe("letters integration", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let alice: { account: string; uid: string; accessToken: string };
  let bob: { account: string; uid: string; accessToken: string };

  async function registerUser(payload: Record<string, string>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload,
    });
    const body = res.json();
    return { account: body.user.account, uid: body.user.uid, accessToken: body.accessToken };
  }

  function createLetter(
    recipient: string,
    content: string,
    transportType = "HORSE_RELAY",
    clientRequestId = `cr-${Math.random()}`,
    token = alice.accessToken
  ) {
    return app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: { authorization: `Bearer ${token}` },
      payload: { recipient, content, transportType, clientRequestId },
    });
  }

  beforeAll(async () => {
    const testDbUrl = requireTestDatabaseUrl(process.env);
    const config = loadConfig({ NODE_ENV: "test" });
    prisma = createPrismaClient(testDbUrl);
    await prisma.refreshToken.deleteMany();
    await prisma.recipientState.deleteMany();
    await prisma.senderState.deleteMany();
    await prisma.letter.deleteMany();
    await prisma.block.deleteMany();
    await prisma.user.deleteMany();
    app = buildApp(config, { prisma });

    alice = await registerUser({
      account: "alice",
      password: "alice-pass-1",
      nickname: "爱丽丝",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    bob = await registerUser({
      account: "bobby",
      password: "bobby-pass-1",
      nickname: "鲍勃",
      province: "北京市",
      city: "北京市",
      district: "海淀区",
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("按 account 创建信件成功，正文加密入库，返回快照", async () => {
    const res = await createLetter("bobby", "今晚打游戏吗？", "HORSE_RELAY", "cr-account");
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.letter.trackingNo).toMatch(/^YS-\d{8}-[A-Z0-9]{5}$/);
    expect(body.letter.sender.account).toBe("alice");
    expect(body.letter.recipient.account).toBe("bobby");
    expect(body.letter.origin.province).toBe("上海市");
    expect(body.letter.target.province).toBe("北京市");
    expect(body.letter.content).toBe("今晚打游戏吗？"); // Sender 可见
    expect("readState" in body.letter).toBe(false);
    expect("encryptedContent" in body.letter).toBe(false);
    expect("id" in body.letter).toBe(false);

    // 数据库正文为密文，非明文
    const dbLetter = await prisma.letter.findUnique({
      where: { trackingNo: body.letter.trackingNo },
    });
    expect(dbLetter?.encryptedContent).not.toBe("今晚打游戏吗？");
    expect(dbLetter?.senderUidSnapshot).toBe(alice.uid);
  });

  it("按 UID 创建信件成功", async () => {
    const res = await createLetter(bob.uid, "hello bob", "HAND_CARRY", "cr-uid");
    expect(res.statusCode).toBe(201);
    expect(res.json().letter.recipient.uid).toBe(bob.uid);
  });

  it("不存在 recipient 返回 404", async () => {
    const res = await createLetter("nobody", "content", "HORSE_RELAY", "cr-missing");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("user_not_found");
  });

  it("clientRequestId 幂等：重复请求返回原 Letter，不重复创建", async () => {
    const r1 = await createLetter("bobby", "idempotent content", "HORSE_RELAY", "cr-idem");
    const r2 = await createLetter("bobby", "idempotent content", "HORSE_RELAY", "cr-idem");
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().letter.trackingNo).toBe(r1.json().letter.trackingNo);
    const count = await prisma.letter.count({ where: { clientRequestId: "cr-idem" } });
    expect(count).toBe(1);
  });

  it("2000 字符允许", async () => {
    const content = "a".repeat(2000);
    const res = await createLetter("bobby", content, "HORSE_RELAY", "cr-2000");
    expect(res.statusCode).toBe(201);
  });

  it("超过 2000 字符拒绝（400 validation）", async () => {
    const content = "a".repeat(2001);
    const res = await createLetter("bobby", content, "HORSE_RELAY", "cr-over");
    expect(res.statusCode).toBe(400);
  });

  it("非法 TransportType 拒绝", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        recipient: "bobby",
        content: "hi",
        transportType: "ROCKET",
        clientRequestId: "cr-bad-transport",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("Recipient 未 Delivered 时 content=null 且不能 open", async () => {
    const res = await createLetter("bobby", "secret to bob", "EXPRESS_RELAY", "cr-not-delivered");
    const trackingNo = res.json().letter.trackingNo;

    // bob 查详情 → content null
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/letters/${trackingNo}`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().letter.content).toBeNull();

    // bob 尝试 open → 409
    const open = await app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/open`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(open.statusCode).toBe(409);
  });

  it("Delivered 后 Recipient 可 open，Sender response 无 readState", async () => {
    const res = await createLetter("bobby", "delivered secret", "PIGEON", "cr-delivered");
    const trackingNo = res.json().letter.trackingNo;

    // 直接置为 DELIVERED（模拟后续 Phase 运输完成）
    await prisma.letter.update({
      where: { trackingNo },
      data: { status: DELIVERED, deliveredAt: new Date() },
    });

    // bob open → 200
    const open = await app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/open`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(open.statusCode).toBe(200);

    // bob 详情 → content 可见，readState OPENED
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/letters/${trackingNo}`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(detail.json().letter.content).toBe("delivered secret");
    expect(detail.json().letter.readState).toBe("OPENED");

    // alice（Sender）详情 → 无 readState，仍可见正文
    const senderDetail = await app.inject({
      method: "GET",
      url: `/api/v1/letters/${trackingNo}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(senderDetail.json().letter.content).toBe("delivered secret");
    expect("readState" in senderDetail.json().letter).toBe(false);
  });

  it("在途信 hide 失败，终态信 hide 成功", async () => {
    // 在途（CREATED）
    const inTransit = await createLetter("bobby", "transit", "HAND_CARRY", "cr-transit-hide");
    const t1 = inTransit.json().letter.trackingNo;
    const hideTransit = await app.inject({
      method: "POST",
      url: `/api/v1/letters/${t1}/hide`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(hideTransit.statusCode).toBe(409);
    expect(hideTransit.json().error).toBe("not_terminal");

    // 终态（DELIVERED）
    const terminal = await createLetter("bobby", "terminal", "HORSE_RELAY", "cr-terminal-hide");
    const t2 = terminal.json().letter.trackingNo;
    await prisma.letter.update({
      where: { trackingNo: t2 },
      data: { status: DELIVERED, deliveredAt: new Date() },
    });
    const hideTerminal = await app.inject({
      method: "POST",
      url: `/api/v1/letters/${t2}/hide`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(hideTerminal.statusCode).toBe(200);
  });

  it("信件列表按发送/接收返回", async () => {
    const sent = await app.inject({
      method: "GET",
      url: "/api/v1/letters?direction=sent",
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().letters.length).toBeGreaterThan(0);
    // 每项不含 internal id / encryptedContent
    for (const l of sent.json().letters) {
      expect("id" in l).toBe(false);
      expect("encryptedContent" in l).toBe(false);
    }

    const received = await app.inject({
      method: "GET",
      url: "/api/v1/letters?direction=received",
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(received.statusCode).toBe(200);
    expect(received.json().letters.length).toBeGreaterThan(0);
  });

  it("hide 后信件不出现在 Sender 列表", async () => {
    const res = await createLetter("bobby", "hide me from list", "HORSE_RELAY", "cr-hide-list");
    const trackingNo = res.json().letter.trackingNo;
    await prisma.letter.update({
      where: { trackingNo },
      data: { status: DELIVERED, deliveredAt: new Date() },
    });
    // Sender hide
    await app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/hide`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    const sent = await app.inject({
      method: "GET",
      url: "/api/v1/letters?direction=sent",
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(
      sent.json().letters.some((l: { trackingNo: string }) => l.trackingNo === trackingNo)
    ).toBe(false);
  });

  it("双方独立隐藏（Sender 隐藏不影响 Recipient）", async () => {
    const res = await createLetter("bobby", "independent hide", "HORSE_RELAY", "cr-indep-hide");
    const trackingNo = res.json().letter.trackingNo;
    await prisma.letter.update({
      where: { trackingNo },
      data: { status: DELIVERED, deliveredAt: new Date() },
    });
    // 仅 Sender 隐藏
    await app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/hide`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    // Sender 列表不含该信
    const sent = await app.inject({
      method: "GET",
      url: "/api/v1/letters?direction=sent",
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(
      sent.json().letters.some((l: { trackingNo: string }) => l.trackingNo === trackingNo)
    ).toBe(false);
    // Recipient 列表仍含该信
    const received = await app.inject({
      method: "GET",
      url: "/api/v1/letters?direction=received",
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(
      received.json().letters.some((l: { trackingNo: string }) => l.trackingNo === trackingNo)
    ).toBe(true);
  });

  it("非参与者访问信件详情返回 404", async () => {
    const res = await createLetter("bobby", "not participant", "HORSE_RELAY", "cr-non-participant");
    const trackingNo = res.json().letter.trackingNo;
    // 注册第三方
    const carol = await registerUser({
      account: "carol",
      password: "carol-pass-1",
      nickname: "Carol",
      province: "S",
      city: "C",
      district: "D",
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/letters/${trackingNo}`,
      headers: { authorization: `Bearer ${carol.accessToken}` },
    });
    expect(detail.statusCode).toBe(404);
  });

  it("重复 open 幂等", async () => {
    const res = await createLetter("bobby", "repeat open", "HORSE_RELAY", "cr-repeat-open");
    const trackingNo = res.json().letter.trackingNo;
    await prisma.letter.update({
      where: { trackingNo },
      data: { status: DELIVERED, deliveredAt: new Date() },
    });
    const open1 = await app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/open`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    const open2 = await app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/open`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(open1.statusCode).toBe(200);
    expect(open2.statusCode).toBe(200);
  });

  it("emoji 2000 code points 允许，2001 拒绝", async () => {
    // 2000 个 emoji = 2000 code points（但 4000 code units）
    const okContent = "😀".repeat(2000);
    const ok = await createLetter("bobby", okContent, "HORSE_RELAY", "cr-emoji-2000");
    expect(ok.statusCode).toBe(201);

    const overContent = "😀".repeat(2001);
    const over = await createLetter("bobby", overContent, "HORSE_RELAY", "cr-emoji-2001");
    expect(over.statusCode).toBe(400);
  });

  it("并发相同请求幂等返回原 Letter（不 500）", async () => {
    const payload = {
      recipient: "bobby",
      content: "concurrent idempotent",
      transportType: "HORSE_RELAY",
      clientRequestId: "cr-concurrent",
    };
    const [r1, r2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/letters",
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload,
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/letters",
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload,
      }),
    ]);
    // 任一请求都可能先完成创建，故无序断言集合 {201, 200}，不做先后假设
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 201]);
    expect(r2.json().letter.trackingNo).toBe(r1.json().letter.trackingNo); // 同一封原 Letter
    const count = await prisma.letter.count({ where: { clientRequestId: "cr-concurrent" } });
    expect(count).toBe(1); // 数据库仅一条记录（幂等）
  });

  it("被拉黑后无法创建新信（Recipient 拉黑 Sender）", async () => {
    // bob 拉黑 alice
    await app.inject({
      method: "POST",
      url: `/api/v1/users/${alice.uid}/block`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    const res = await createLetter("bobby", "blocked content", "HORSE_RELAY", "cr-blocked");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("blocked_by_recipient");
  });
});

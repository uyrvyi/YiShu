import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";
import { DELIVERED } from "../lib/letter-view.js";
import { acquireBlockLetterPairLock } from "../lib/blockLock.js";

/**
 * Phase 3 Gate 边界集成测试（fingerprint、simulationSeed、hide/open/snapshot、advisory lock）。
 * 仅 *_test 库。注意：advisory lock 拉黑测试放最后（避免影响 alice 后续发信）。
 */
describe("letters gate integration", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let alice: { account: string; uid: string; accessToken: string };
  let bob: { account: string; uid: string; accessToken: string };

  async function registerUser(payload: Record<string, string>) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload });
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
    await prisma.recipientState.deleteMany();
    await prisma.senderState.deleteMany();
    await prisma.letter.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.block.deleteMany();
    await prisma.user.deleteMany();
    app = buildApp(config, { prisma });
    alice = await registerUser({
      account: "aliceg",
      password: "aliceg-pass",
      nickname: "AG",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    bob = await registerUser({
      account: "bobg",
      password: "bobg-pass",
      nickname: "BG",
      province: "北京市",
      city: "北京市",
      district: "海淀区",
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("fingerprint：同 key 同 body 返回原 Letter（200）", async () => {
    const r1 = await createLetter("bobg", "same body", "HORSE_RELAY", "fp-same");
    const r2 = await createLetter("bobg", "same body", "HORSE_RELAY", "fp-same");
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().letter.trackingNo).toBe(r1.json().letter.trackingNo);
  });

  it("fingerprint：同 key recipient 不同 → 409", async () => {
    await createLetter("bobg", "content X", "HORSE_RELAY", "fp-recipient");
    const carol = await registerUser({
      account: "carolg",
      password: "carolg-pass",
      nickname: "CG",
      province: "S",
      city: "C",
      district: "D",
    });
    const r = await createLetter(carol.uid, "content X", "HORSE_RELAY", "fp-recipient");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("idempotency_conflict");
  });

  it("fingerprint：同 key content 不同 → 409", async () => {
    await createLetter("bobg", "body one", "HORSE_RELAY", "fp-content");
    const r = await createLetter("bobg", "body two", "HORSE_RELAY", "fp-content");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("idempotency_conflict");
  });

  it("fingerprint：同 key transport 不同 → 409", async () => {
    await createLetter("bobg", "body t", "HORSE_RELAY", "fp-transport");
    const r = await createLetter("bobg", "body t", "PIGEON", "fp-transport");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("idempotency_conflict");
  });

  it("fingerprint：account 与 UID 解析同一 recipient 语义一致", async () => {
    await createLetter("bobg", "resolve same", "HORSE_RELAY", "fp-resolve");
    const r = await createLetter(bob.uid, "resolve same", "HORSE_RELAY", "fp-resolve");
    expect(r.statusCode).toBe(200); // 同 recipient → 幂等
  });

  it("fingerprint：不同 Sender 使用相同 clientRequestId → 各自创建", async () => {
    const r1 = await createLetter("bobg", "multi sender", "HORSE_RELAY", "fp-multisender");
    const r2 = await createLetter(
      "bobg",
      "multi sender",
      "HORSE_RELAY",
      "fp-multisender",
      bob.accessToken
    );
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r1.json().letter.trackingNo).not.toBe(r2.json().letter.trackingNo);
  });

  it("simulationSeed 非空、格式合法、两封不同、API 不返回", async () => {
    const r1 = await createLetter("bobg", "seed1", "HORSE_RELAY", "seed-1");
    const r2 = await createLetter("bobg", "seed2", "HORSE_RELAY", "seed-2");
    expect("simulationSeed" in r1.json().letter).toBe(false);
    expect("requestFingerprint" in r1.json().letter).toBe(false);
    const s1 = await prisma.letter.findUnique({
      where: { trackingNo: r1.json().letter.trackingNo },
    });
    const s2 = await prisma.letter.findUnique({
      where: { trackingNo: r2.json().letter.trackingNo },
    });
    expect(s1?.simulationSeed).toMatch(/^[0-9a-f]{64}$/);
    expect(s1?.simulationSeed.length).toBeGreaterThan(0);
    expect(s1?.simulationSeed).not.toBe(s2?.simulationSeed);
  });

  it("hide：Sender hide 只影响 Sender 列表，detail 仍可访问", async () => {
    const r = await createLetter("bobg", "hide only sender", "HORSE_RELAY", "hide-sender-only");
    const trackingNo = r.json().letter.trackingNo;
    await prisma.letter.update({
      where: { trackingNo },
      data: { status: DELIVERED, deliveredAt: new Date() },
    });
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
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/letters/${trackingNo}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(detail.statusCode).toBe(200);
  });

  it("open：Sender 不能 open；重复 open 不重写 openedAt", async () => {
    const r = await createLetter("bobg", "open rules", "HORSE_RELAY", "open-rules");
    const trackingNo = r.json().letter.trackingNo;
    await prisma.letter.update({
      where: { trackingNo },
      data: { status: DELIVERED, deliveredAt: new Date() },
    });
    const senderOpen = await app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/open`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(senderOpen.statusCode).toBe(404);
    const stranger = await registerUser({
      account: "stranger",
      password: "stranger-pass",
      nickname: "S",
      province: "S",
      city: "C",
      district: "D",
    });
    const strangerOpen = await app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/open`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect(strangerOpen.statusCode).toBe(404);
    const letterRow = await prisma.letter.findUnique({ where: { trackingNo } });
    const letterId = letterRow?.id;
    await app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/open`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    const openedAt1 = letterId
      ? (await prisma.recipientState.findUnique({ where: { letterId } }))?.openedAt
      : null;
    await app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/open`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    const openedAt2 = letterId
      ? (await prisma.recipientState.findUnique({ where: { letterId } }))?.openedAt
      : null;
    expect(openedAt1?.getTime()).toBe(openedAt2?.getTime());
  });

  it("snapshot：创建后修改 User 可变字段，Letter 仍返回创建时快照", async () => {
    const r = await createLetter("bobg", "snapshot test", "HORSE_RELAY", "snapshot-1");
    const trackingNo = r.json().letter.trackingNo;
    await prisma.user.update({ where: { uid: alice.uid }, data: { nickname: "改后昵称" } });
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/letters/${trackingNo}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(detail.json().letter.sender.nickname).toBe("AG"); // 快照保留创建时昵称
  });

  it("advisory lock：Block 先提交 → Letter 403，DB 无新 Letter", async () => {
    await app.inject({
      method: "POST",
      url: `/api/v1/users/${alice.uid}/block`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    const letter = await createLetter(
      "bobg",
      "should be blocked",
      "HORSE_RELAY",
      "lock-block-first"
    );
    expect(letter.statusCode).toBe(403);
    expect(letter.json().error).toBe("blocked_by_recipient");
    const aliceId = (await prisma.user.findUnique({ where: { uid: alice.uid } }))?.id;
    const cnt = await prisma.letter.count({
      where: { clientRequestId: "lock-block-first", senderId: aliceId },
    });
    expect(cnt).toBe(0);
  });

  it("advisory lock：Letter 先提交 → Letter 成功，随后 Block 成功，原 Letter 保留", async () => {
    const c1 = await registerUser({
      account: "charlieg",
      password: "c1-pass-1",
      nickname: "C1",
      province: "S",
      city: "C",
      district: "D",
    });
    const d1 = await registerUser({
      account: "davieg",
      password: "d1-pass-1",
      nickname: "D1",
      province: "S",
      city: "C",
      district: "D",
    });
    const letter = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: { authorization: `Bearer ${c1.accessToken}` },
      payload: {
        recipient: d1.uid,
        content: "letter first",
        transportType: "HAND_CARRY",
        clientRequestId: "lock-letter-first",
      },
    });
    expect(letter.statusCode).toBe(201);
    const block = await app.inject({
      method: "POST",
      url: `/api/v1/users/${c1.uid}/block`,
      headers: { authorization: `Bearer ${d1.accessToken}` },
    });
    expect(block.statusCode).toBe(200);
    const c1Id = (await prisma.user.findUnique({ where: { uid: c1.uid } }))?.id;
    const cnt = await prisma.letter.count({
      where: { clientRequestId: "lock-letter-first", senderId: c1Id },
    });
    expect(cnt).toBe(1);
  });

  /** 等待有会话在 advisory lock 上排队等待（granted=false），替代固定延迟的确定性信号。 */
  async function waitForAdvisoryWaiter(timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted = false
      `;
      if ((rows[0]?.n ?? 0) > 0) {
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("timed out waiting for advisory lock waiter");
  }

  it("advisory lock 确定性：Block 先获锁 → Letter 403 且不落库", async () => {
    const c1 = await registerUser({
      account: "lockc2",
      password: "lockc2-pass",
      nickname: "LC2",
      province: "S",
      city: "C",
      district: "D",
    });
    const d1 = await registerUser({
      account: "lockd2",
      password: "lockd2-pass",
      nickname: "LD2",
      province: "S",
      city: "C",
      district: "D",
    });
    const c1Row = await prisma.user.findUnique({ where: { uid: c1.uid } });
    const d1Row = await prisma.user.findUnique({ where: { uid: d1.uid } });

    // Block 事务先获取 pair lock；等待 Letter 请求在锁上排队后，锁内创建 Block，再提交释放锁。
    const blockTxn = prisma.$transaction(async (tx) => {
      await acquireBlockLetterPairLock(tx, c1Row?.id ?? 0n, d1Row?.id ?? 0n);
      await waitForAdvisoryWaiter();
      await tx.block.upsert({
        where: {
          blockerId_blockedId: { blockerId: c1Row?.id ?? 0n, blockedId: d1Row?.id ?? 0n },
        },
        update: {},
        create: { blockerId: c1Row?.id ?? 0n, blockedId: d1Row?.id ?? 0n },
      });
    });

    // Letter 请求（d1 → c1）在锁上排队；Block 提交释放锁后，Letter 获得锁并看到已拉黑 → 403
    const letterRes = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: { authorization: `Bearer ${d1.accessToken}` },
      payload: {
        recipient: c1.uid,
        content: "race block-first",
        transportType: "HORSE_RELAY",
        clientRequestId: "lock-race-block-first",
      },
    });
    await blockTxn;

    expect(letterRes.statusCode).toBe(403);
    expect(letterRes.json().error).toBe("blocked_by_recipient");
    const d1Id = (await prisma.user.findUnique({ where: { uid: d1.uid } }))?.id;
    const cnt = await prisma.letter.count({
      where: { clientRequestId: "lock-race-block-first", senderId: d1Id },
    });
    expect(cnt).toBe(0); // Letter 未落库
  });

  it("advisory lock 确定性：Letter 先获锁 → Letter 201 且随后 Block 不删除旧信", async () => {
    const c1 = await registerUser({
      account: "lockc3",
      password: "lockc3-pass",
      nickname: "LC3",
      province: "S",
      city: "C",
      district: "D",
    });
    const d1 = await registerUser({
      account: "lockd3",
      password: "lockd3-pass",
      nickname: "LD3",
      province: "S",
      city: "C",
      district: "D",
    });
    const c1Row = await prisma.user.findUnique({ where: { uid: c1.uid } });
    const d1Row = await prisma.user.findUnique({ where: { uid: d1.uid } });

    // 先由一个空事务持有 pair lock，让 Letter 请求排队；确认排队后释放锁，
    // 使 Letter 成为第一个获锁者并创建成功。
    const holderTxn = prisma.$transaction(async (tx) => {
      await acquireBlockLetterPairLock(tx, d1Row?.id ?? 0n, c1Row?.id ?? 0n);
      await waitForAdvisoryWaiter();
    });

    const letterRes = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: { authorization: `Bearer ${d1.accessToken}` },
      payload: {
        recipient: c1.uid,
        content: "race letter-first",
        transportType: "HORSE_RELAY",
        clientRequestId: "lock-race-letter-first",
      },
    });
    await holderTxn; // 释放锁 → Letter 获得锁并提交

    expect(letterRes.statusCode).toBe(201);

    // Letter 已提交后，Block 成功；原 Letter 保留（不被删除/拦截）
    const block = await app.inject({
      method: "POST",
      url: `/api/v1/users/${d1.uid}/block`,
      headers: { authorization: `Bearer ${c1.accessToken}` },
    });
    expect(block.statusCode).toBe(200);
    const d1Id = (await prisma.user.findUnique({ where: { uid: d1.uid } }))?.id;
    const cnt = await prisma.letter.count({
      where: { clientRequestId: "lock-race-letter-first", senderId: d1Id },
    });
    expect(cnt).toBe(1); // 原 Letter 保留
  });
});

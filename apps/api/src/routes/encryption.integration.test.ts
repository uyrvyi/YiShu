import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient } from "@yishu/db";
import {
  createIdentity,
  createRecovery,
  publicIdentity,
  encryptLetter,
  decryptLetter,
  encryptImage,
  decryptImage,
  E2EE_VERSION,
  type PrivateIdentity,
  type IdentityRegistration,
  type ImageSecret,
} from "@yishu/shared/e2ee";
import { buildApp } from "../app.js";

const rng = async (n: number) => new Uint8Array(randomBytes(n));
describe("E2EE authenticated server relay", () => {
  const prisma = createPrismaClient(requireTestDatabaseUrl(process.env));
  let app: ReturnType<typeof buildApp>;
  let directory: string;
  let a: { uid: string; accessToken: string }, b: typeof a, c: typeof a;
  let alice: PrivateIdentity, bob: PrivateIdentity;
  let registration: IdentityRegistration;
  let legacyTracking: string;
  const auth = (user: typeof a) => ({ authorization: `Bearer ${user.accessToken}` });
  async function register(account: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        account,
        password: "e2ee-test-password-1",
        nickname: account,
        province: "上海市",
        city: "上海市",
        district: "黄浦区",
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { uid: body.user.uid as string, accessToken: body.accessToken as string };
  }
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "yishu-e2ee-"));
    app = buildApp(
      { ...loadConfig({ NODE_ENV: "test" }), MEDIA_STORAGE_DIR: directory },
      { prisma }
    );
    const suffix = randomBytes(3).toString("hex");
    a = await register(`ea${suffix}`);
    b = await register(`eb${suffix}`);
    c = await register(`ec${suffix}`);
    const legacy = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: auth(a),
      payload: {
        recipient: b.uid,
        content: "旧信保持原样",
        transportType: "HAND_CARRY",
        clientRequestId: "legacy",
      },
    });
    expect(legacy.statusCode).toBe(201);
    legacyTracking = legacy.json().letter.trackingNo;
    alice = await createIdentity(a.uid, rng);
    bob = await createIdentity(b.uid, rng);
    registration = (await createRecovery(alice, rng)).registration;
    for (const [user, record] of [
      [a, registration],
      [b, (await createRecovery(bob, rng)).registration],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/encryption/me",
        headers: auth(user),
        payload: record,
      });
      expect(res.statusCode).toBe(200);
    }
  });
  afterAll(async () => {
    if (a && b && c) {
      const users = await prisma.user.findMany({ where: { uid: { in: [a.uid, b.uid, c.uid] } } });
      await prisma.letter.deleteMany({ where: { senderId: { in: users.map((user) => user.id) } } });
      await prisma.refreshToken.deleteMany({
        where: { userId: { in: users.map((user) => user.id) } },
      });
      await prisma.user.deleteMany({ where: { uid: { in: [a.uid, b.uid, c.uid] } } });
    }
    await app?.close();
    await prisma.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("requires authentication, separates public keys from private encrypted backups, and prevents identity replacement", async () => {
    expect((await app.inject({ url: "/api/v1/encryption/me" })).statusCode).toBe(401);
    const own = await app.inject({ url: "/api/v1/encryption/me", headers: auth(a) });
    expect(own.json().registration).toEqual(registration);
    expect(own.headers["cache-control"]).toBe("private, no-store");
    const peer = await app.inject({ url: `/api/v1/encryption/keys/${a.uid}`, headers: auth(b) });
    expect(peer.json()).toEqual({ identity: publicIdentity(alice) });
    expect(peer.body).not.toContain(alice.signingSecret);
    expect(peer.body).not.toContain("backup");
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/encryption/me",
      headers: auth(a),
      payload: registration,
    });
    expect(again.statusCode).toBe(200);
    const other = (await createRecovery(await createIdentity(a.uid, rng), rng)).registration;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/encryption/me",
          headers: auth(a),
          payload: other,
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/encryption/me",
          headers: auth(c),
          payload: registration,
        })
      ).statusCode
    ).toBe(400);
  });
  it("preserves old letters but refuses silent plaintext downgrade for enrolled accounts", async () => {
    const old = await app.inject({ url: `/api/v1/letters/${legacyTracking}`, headers: auth(a) });
    expect(old.json().letter.content).toBe("旧信保持原样");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: auth(a),
      payload: {
        recipient: b.uid,
        content: "no downgrade",
        transportType: "HAND_CARRY",
        clientRequestId: "downgrade",
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("e2ee_required");
  });
  it("stores opaque images and envelopes, withholds body/timestamp/keys/images before delivery and excludes third parties", async () => {
    const source = new Uint8Array(Buffer.from("89504e470d0a1a0a0000000000000000", "hex"));
    const encrypted = await encryptImage(source, rng);
    const boundary = "e2ee-boundary";
    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/media/encrypted-images",
      headers: { ...auth(a), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="encrypted.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
        ),
        Buffer.from(encrypted.ciphertext),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(upload.statusCode).toBe(201);
    const image = upload.json().image;
    expect(await readFile(path.join(directory, `${image.id}.enc`))).toEqual(
      Buffer.from(encrypted.ciphertext)
    );
    const secret: ImageSecret = {
      id: image.id,
      key: encrypted.key,
      token: encrypted.token,
      digest: encrypted.digest,
      mimeType: "image/png",
      width: 1,
      height: 1,
      byteSize: source.length,
    };
    const plain = {
      content: "新的端到端加密信件",
      writtenAt: "2026-10-05T13:00:00.000Z",
      images: [secret],
    };
    const e2ee = await encryptLetter(
      alice,
      publicIdentity(bob),
      plain,
      "encrypted",
      "HAND_CARRY",
      rng
    );
    const payload = {
      recipient: b.uid,
      transportType: "HAND_CARRY",
      clientRequestId: "encrypted",
      imageIds: [image.id],
      e2ee,
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: auth(a),
      payload,
    });
    expect(created.statusCode).toBe(201);
    const letter = created.json().letter;
    expect(letter.content).toBeNull();
    expect(letter.writtenAt).toBeNull();
    expect(letter.images).toEqual([]);
    expect(decryptLetter(alice, letter.e2ee)).toEqual(plain);
    const db = await prisma.letter.findUniqueOrThrow({ where: { trackingNo: letter.trackingNo } });
    expect(db.contentVersion).toBe(E2EE_VERSION);
    expect(db.encryptedContent).toBe("");
    expect(db.writtenAt).toBeNull();
    expect(JSON.stringify(db.e2ee)).not.toContain(plain.content);
    const before = await app.inject({
      url: `/api/v1/letters/${letter.trackingNo}`,
      headers: auth(b),
    });
    expect(before.json().letter.e2ee).toBeNull();
    expect(before.json().letter.images).toEqual([]);
    const list = await app.inject({ url: "/api/v1/letters?direction=received", headers: auth(b) });
    expect(
      list
        .json()
        .letters.find((item: { trackingNo: string }) => item.trackingNo === letter.trackingNo).e2ee
    ).toBeNull();
    expect((await app.inject({ url: image.url, headers: auth(b) })).statusCode).toBe(404);
    expect(
      (await app.inject({ url: `/api/v1/letters/${letter.trackingNo}`, headers: auth(c) }))
        .statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/letters", headers: auth(a), payload }))
        .statusCode
    ).toBe(200);
    const modified = structuredClone(payload);
    modified.e2ee.payload.nonce = "ff".repeat(24);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/letters",
          headers: auth(a),
          payload: modified,
        })
      ).statusCode
    ).toBe(409);
    const tampered = structuredClone(payload);
    tampered.clientRequestId = "tampered";
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/letters",
          headers: auth(a),
          payload: tampered,
        })
      ).statusCode
    ).toBe(400);
    await prisma.letter.update({ where: { id: db.id }, data: { status: "DELIVERED" } });
    const delivered = await app.inject({
      url: `/api/v1/letters/${letter.trackingNo}`,
      headers: auth(b),
    });
    expect(decryptLetter(bob, delivered.json().letter.e2ee)).toEqual(plain);
    const pixels = await app.inject({ url: image.url, headers: auth(b) });
    expect(pixels.headers["content-type"]).toBe("application/octet-stream");
    expect(decryptImage(new Uint8Array(pixels.rawPayload), secret)).toEqual(source);
    expect((await app.inject({ url: image.url, headers: auth(c) })).statusCode).toBe(404);
  });
});

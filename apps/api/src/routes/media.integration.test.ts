import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { MAX_IMAGE_BYTES } from "../lib/media.js";
import { computeRequestFingerprint } from "../lib/fingerprint.js";
import { cleanupExpiredMedia } from "../lib/media-cleanup.js";

describe("private media and writing timestamp integration", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let directory: string;
  let png: Buffer;
  const users: Array<{ id: bigint; uid: string; token: string }> = [];
  function user(index: number) {
    const value = users[index];
    if (!value) throw new Error("missing_test_user");
    return value;
  }
  const auth = (index: number) => ({ authorization: `Bearer ${user(index).token}` });

  async function upload(buffer = png, index = 0, url = "/api/v1/media/images") {
    const boundary = "yishu-test-boundary";
    return app.inject({
      method: "POST",
      url,
      headers: { ...auth(index), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`
        ),
        buffer,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
  }

  async function create(
    images: string[] = [],
    key = `media-${Math.random()}`,
    writtenAt = "2026-10-01T08:12:00.000Z"
  ) {
    return app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: auth(0),
      payload: {
        recipient: user(1).uid,
        content: "private photo letter",
        transportType: "HORSE_RELAY",
        clientRequestId: key,
        writtenAt,
        imageIds: images,
      },
    });
  }

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "yishu-media-"));
    prisma = createPrismaClient(requireTestDatabaseUrl(process.env));
    app = buildApp(loadConfig({ NODE_ENV: "test", MEDIA_STORAGE_DIR: directory }), { prisma });
    const suffix = Math.random().toString(36).slice(2, 9);
    for (const index of [0, 1, 2]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          account: `m${index}${suffix}`,
          password: "media-test-password",
          nickname: `Media${index}`,
          province: "北京市",
          city: "北京市",
          district: "海淀区",
        },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      const user = await prisma.user.findUniqueOrThrow({ where: { uid: body.user.uid } });
      users.push({ id: user.id, uid: user.uid, token: body.accessToken });
    }
    png = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#3a9070" } })
      .png()
      .toBuffer();
  });

  afterAll(async () => {
    await app.close();
    const ids = users.map((user) => user.id);
    await prisma.letter.deleteMany({ where: { senderId: { in: ids } } });
    await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  });

  it("encrypts real pixels; hides images and writing time until delivery, even through direct image URLs", async () => {
    const uploaded = await upload();
    expect(uploaded.statusCode).toBe(201);
    const image = uploaded.json().image;
    const disk = await readFile(path.join(directory, `${image.id}.enc`));
    expect(disk.includes(png)).toBe(false);
    expect(image).toMatchObject({ mimeType: "image/png", width: 24, height: 16 });
    expect((await app.inject({ url: image.url })).statusCode).toBe(401);
    expect((await app.inject({ url: image.url, headers: auth(2) })).statusCode).toBe(404);
    const response = await create([image.id]);
    expect(response.statusCode).toBe(201);
    const letter = response.json().letter;
    expect(letter.writtenAt).toBe("2026-10-01T08:12:00.000Z");
    expect(letter.images).toEqual([image]);
    const recipient = await app.inject({
      url: `/api/v1/letters/${letter.trackingNo}`,
      headers: auth(1),
    });
    expect(recipient.json().letter).toMatchObject({ content: null, writtenAt: null, images: [] });
    expect(recipient.json().letter.createdAt).toBeTruthy();
    expect((await app.inject({ url: image.url, headers: auth(1) })).statusCode).toBe(404);
    const senderImage = await app.inject({ url: image.url, headers: auth(0) });
    expect(senderImage.rawPayload.equals(png)).toBe(true);
    expect(senderImage.headers["cache-control"]).toBe("private, no-store");
    await prisma.letter.update({
      where: { trackingNo: letter.trackingNo },
      data: { status: "DELIVERED" },
    });
    const delivered = await app.inject({
      url: `/api/v1/letters/${letter.trackingNo}`,
      headers: auth(1),
    });
    expect(delivered.json().letter).toMatchObject({
      content: "private photo letter",
      writtenAt: letter.writtenAt,
      images: [image],
    });
    expect((await app.inject({ url: image.url, headers: auth(1) })).rawPayload.equals(png)).toBe(
      true
    );
    expect(
      (await app.inject({ method: "DELETE", url: image.url, headers: auth(0) })).statusCode
    ).toBe(404);
  });

  it("rejects oversize, forged, broken and unsupported image payloads", async () => {
    expect((await upload(Buffer.alloc(MAX_IMAGE_BYTES + 1))).statusCode).toBe(413);
    expect((await upload(Buffer.from("<svg onload='evil()'/>"))).statusCode).toBe(415);
    expect((await upload(png.subarray(0, 32))).statusCode).toBe(415);
  });

  it("cleans expired unclaimed files and metadata, preserving current drafts, letters and avatars", async () => {
    const stale = (await upload(png, 2)).json().image;
    const active = (await upload(png, 2)).json().image;
    const avatar = (await upload(png, 2, "/api/v1/users/me/avatar")).json().image;
    const bound = await prisma.mediaAsset.findFirstOrThrow({
      where: { ownerId: user(0).id, letterId: { not: null } },
      select: { id: true },
    });
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await prisma.mediaAsset.updateMany({
      where: { id: { in: [stale.id, avatar.id, bound.id] } },
      data: { createdAt: past },
    });
    expect(await cleanupExpiredMedia(prisma, directory)).toBeGreaterThanOrEqual(1);
    expect(await prisma.mediaAsset.findUnique({ where: { id: stale.id } })).toBeNull();
    await expect(readFile(path.join(directory, `${stale.id}.enc`))).rejects.toThrow();
    for (const id of [active.id, avatar.id, bound.id]) {
      expect(await prisma.mediaAsset.findUnique({ where: { id } })).not.toBeNull();
      expect((await readFile(path.join(directory, `${id}.enc`))).length).toBeGreaterThan(0);
    }
    expect(await prisma.mediaAsset.count({ where: { letterId: { not: null } } })).toBeGreaterThan(
      0
    );
  });

  it("retains metadata when file cleanup fails so a later batch can retry", async () => {
    const stale = (await upload(png, 2)).json().image;
    await prisma.mediaAsset.update({
      where: { id: stale.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    const filename = path.join(directory, `${stale.id}.enc`);
    await rm(filename);
    await mkdir(filename);
    await expect(cleanupExpiredMedia(prisma, directory)).rejects.toThrow();
    expect(await prisma.mediaAsset.findUnique({ where: { id: stale.id } })).not.toBeNull();
    await rm(filename, { recursive: true });
    await cleanupExpiredMedia(prisma, directory);
    expect(await prisma.mediaAsset.findUnique({ where: { id: stale.id } })).toBeNull();
  });

  it("rejects the temporary quota before parsing even an invalid uploaded file", async () => {
    const ids = await prisma.mediaAsset.findMany({
      where: { ownerId: user(2).id },
      select: { id: true },
    });
    const pending = await prisma.mediaAsset.count({
      where: { ownerId: user(2).id, letterId: null, avatarFor: { is: null } },
    });
    const newlyAdded: string[] = [];
    try {
      for (let index = pending; index < 36; index++) {
        const image = (await upload(png, 2)).json().image;
        newlyAdded.push(image.id);
      }
      const rejected = await upload(Buffer.from("not-an-image"), 2);
      expect(rejected.statusCode).toBe(429);
      expect(rejected.json()).toEqual({ error: "too_many_pending_images" });
    } finally {
      await prisma.mediaAsset.deleteMany({ where: { id: { in: newlyAdded } } });
      for (const id of newlyAdded) await rm(path.join(directory, `${id}.enc`), { force: true });
    }
    expect(
      await prisma.mediaAsset.count({ where: { id: { in: ids.map((asset) => asset.id) } } })
    ).toBe(ids.length);
  });

  it("enforces nine images, ownership, unique IDs and atomic single-use claiming", async () => {
    const image = (await upload()).json().image;
    const foreign = (await upload(png, 1)).json().image;
    expect((await create([foreign.id])).statusCode).toBe(400);
    expect((await create([image.id, image.id])).statusCode).toBe(400);
    expect((await create(Array.from({ length: 10 }, () => crypto.randomUUID()))).statusCode).toBe(
      400
    );
    const key = `parallel-${Math.random()}`;
    const [a, b] = await Promise.all([create([image.id], key), create([image.id], key)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().letter.trackingNo).toBe(b.json().letter.trackingNo);
    expect((await create([image.id])).statusCode).toBe(400);
    expect((await create([], key)).statusCode).toBe(409);
  });

  it("checks encrypted file integrity instead of serving corrupt ciphertext", async () => {
    const image = (await upload()).json().image;
    const filename = path.join(directory, `${image.id}.enc`);
    const encrypted = await readFile(filename);
    encrypted[encrypted.length - 1] = (encrypted[encrypted.length - 1] ?? 0) ^ 1;
    await writeFile(filename, encrypted);
    expect((await app.inject({ url: image.url, headers: auth(0) })).statusCode).toBe(500);
    expect(
      (await app.inject({ method: "DELETE", url: image.url, headers: auth(0) })).statusCode
    ).toBe(204);
  });

  it("updates an avatar without changing letters or keeping the old avatar accessible", async () => {
    const before = await prisma.letter.findMany({ where: { senderId: user(0).id } });
    const first = (await upload(png, 0, "/api/v1/users/me/avatar")).json();
    const second = (await upload(png, 0, "/api/v1/users/me/avatar")).json();
    expect(second.user.avatarUrl).toBe(second.image.url);
    expect((await app.inject({ url: first.image.url, headers: auth(1) })).statusCode).toBe(404);
    expect((await app.inject({ url: second.image.url, headers: auth(1) })).statusCode).toBe(200);
    expect(await prisma.letter.findMany({ where: { senderId: user(0).id } })).toEqual(before);
  });

  it("keeps legacy fingerprints compatible and treats new images/time as part of idempotency", () => {
    const input = {
      recipientUid: "12345678",
      content: "body",
      transportType: "HORSE_RELAY" as const,
    };
    expect(computeRequestFingerprint(input)).toBe(
      computeRequestFingerprint({ ...input, imageIds: [] })
    );
    expect(computeRequestFingerprint(input)).not.toBe(
      computeRequestFingerprint({ ...input, writtenAt: "2026-10-01T00:00:00Z" })
    );
  });
});

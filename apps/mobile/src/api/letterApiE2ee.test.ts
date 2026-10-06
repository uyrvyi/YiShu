import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createIdentity,
  createRecovery,
  publicIdentity,
  encryptImage,
  decryptImage,
  encryptLetter,
  decryptLetter,
  type ImageSecret,
} from "@yishu/shared/e2ee";
import { createLetterApi } from "./letterApi";
import type { EncryptionClient } from "../e2ee/client";
const rng = async (n: number) => new Uint8Array(randomBytes(n));
const input = { uri: "file:photo.jpg", name: "photo.jpg", mimeType: "image/jpeg" };
const bytes = new Uint8Array([255, 216, 255]);
async function fixture() {
  const sender = await createIdentity("12345678", rng),
    recipient = await createIdentity("23456789", rng);
  const recovery = await createRecovery(sender, rng),
    encrypted = await encryptImage(bytes, rng);
  const secret: ImageSecret = {
    id: "11111111-1111-4111-8111-111111111111",
    key: encrypted.key,
    token: encrypted.token,
    digest: encrypted.digest,
    mimeType: "image/jpeg",
    width: 1,
    height: 1,
    byteSize: bytes.length,
  };
  const cleanup = vi.fn();
  const client: EncryptionClient = {
    ensureReady: async () => {},
    backupRecoveryCode: async () => recovery.recoveryCode,
    reset: vi.fn(),
    status: async () => ({
      uid: sender.uid,
      enabled: true,
      available: true,
      identity: sender,
      backupAvailable: true,
    }),
    prepareEnrollment: async () => ({ identity: sender, ...recovery }),
    activate: async () => {},
    recover: async () => {},
    verifyContact: async () => {},
    prepareCreate: async (plain) => ({
      recipient: recipient.uid,
      transportType: plain.transportType,
      clientRequestId: plain.clientRequestId,
      imageIds: plain.imageIds ?? [],
      e2ee: await encryptLetter(
        sender,
        publicIdentity(recipient),
        {
          content: plain.content,
          writtenAt: plain.writtenAt ?? new Date().toISOString(),
          images: plain.encryptedImages ?? [],
        },
        plain.clientRequestId,
        plain.transportType,
        rng
      ),
    }),
    decodeLetter: async (letter) =>
      letter.e2ee ? { ...letter, ...decryptLetter(sender, letter.e2ee), images: [] } : letter,
    prepareImage: vi.fn(async () => ({
      input: {
        uri: "file:encrypted.bin",
        name: "encrypted.bin",
        mimeType: "application/octet-stream",
      },
      secret,
      cleanup,
    })),
    decodeImage: async (ciphertext, metadata) => decryptImage(ciphertext, metadata),
  };
  const headers = { authorization: "Bearer token" };
  return { client, secret, encrypted, cleanup, headers };
}
describe("E2EE mobile API wire plumbing", () => {
  it("discards an image if the account changes while reading the response body", async () => {
    const { client, secret, encrypted } = await fixture();
    let generation = 1;
    const decode = vi.spyOn(client, "decodeImage");
    const response = new Response(encrypted.ciphertext.buffer as ArrayBuffer);
    response.arrayBuffer = async () => {
      generation++;
      return encrypted.ciphertext.buffer as ArrayBuffer;
    };
    const api = createLetterApi({
      baseUrl: "https://api.example.com",
      getAccessToken: async () => "token",
      encryption: client,
      getSessionVersion: () => generation,
      fetchImpl: async () => response,
    });
    await expect(api.getImageData(secret.id, false, secret)).rejects.toThrow(
      "e2ee_session_changed"
    );
    expect(decode).not.toHaveBeenCalled();
  });
  it("discards decrypted pixels if the account changes during decryption", async () => {
    const { client, secret, encrypted } = await fixture();
    let generation = 1;
    client.decodeImage = async () => {
      generation++;
      return bytes;
    };
    const api = createLetterApi({
      baseUrl: "https://api.example.com",
      getAccessToken: async () => "token",
      encryption: client,
      getSessionVersion: () => generation,
      fetchImpl: async () => new Response(encrypted.ciphertext.buffer as ArrayBuffer),
    });
    await expect(api.getImageData(secret.id, false, secret)).rejects.toThrow(
      "e2ee_session_changed"
    );
  });
  it("also fences legacy image body parsing across accounts", async () => {
    let generation = 1;
    const response = new Response(bytes, { headers: { "content-type": "image/jpeg" } });
    response.arrayBuffer = async () => {
      generation++;
      return bytes.buffer as ArrayBuffer;
    };
    const api = createLetterApi({
      baseUrl: "https://api.example.com",
      getAccessToken: async () => "token",
      getSessionVersion: () => generation,
      fetchImpl: async () => response,
    });
    await expect(api.getImageData("image")).rejects.toThrow("e2ee_session_changed");
  });
  it("sends only signed ciphertext and decrypts the letter response locally", async () => {
    const { client } = await fixture();
    const fetchImpl = vi.fn(async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      expect(wire).not.toHaveProperty("content");
      expect(wire).not.toHaveProperty("writtenAt");
      expect(wire).not.toHaveProperty("encryptedImages");
      expect(JSON.stringify(wire)).not.toContain("私密正文");
      return new Response(
        JSON.stringify({ letter: { e2ee: wire.e2ee, content: null, images: [] } }),
        { status: 201 }
      );
    });
    const api = createLetterApi({
      baseUrl: "https://api.example.com",
      getAccessToken: async () => "token",
      encryption: client,
      fetchImpl,
    });
    const result = await api.createLetter({
      recipient: "23456789",
      content: "私密正文",
      writtenAt: "2026-10-05T13:00:00.000Z",
      transportType: "HAND_CARRY",
      clientRequestId: "one",
    });
    expect(result.content).toBe("私密正文");
    expect(result.writtenAt).toBe("2026-10-05T13:00:00.000Z");
  });
  it.each([201, 503])(
    "native progress upload uses the encrypted temporary file and cleans up after status %i",
    async (status) => {
      const { client, secret, cleanup } = await fixture();
      const progress = vi.fn();
      const fetchImpl = vi.fn(async (url, init) => {
        expect(String(url).endsWith("/media/encrypted-images")).toBe(true);
        const upload = (init as import("./imageUploadFetch").ImageUploadRequestInit).imageUpload;
        expect(upload?.image.uri).toBe("file:encrypted.bin");
        expect(upload?.image.mimeType).toBe("application/octet-stream");
        expect(upload).not.toHaveProperty("key");
        return new Response(
          JSON.stringify(
            status === 201
              ? { image: { id: secret.id, url: `/api/v1/media/${secret.id}` } }
              : { error: "internal_error" }
          ),
          { status }
        );
      });
      const api = createLetterApi({
        baseUrl: "https://api.example.com",
        getAccessToken: async () => "token",
        encryption: client,
        fetchImpl,
      });
      if (status === 201)
        expect((await api.uploadImage(input, false, progress)).encryption).toEqual(secret);
      else await expect(api.uploadImage(input, false, progress)).rejects.toThrow();
      expect(cleanup).toHaveBeenCalledOnce();
    }
  );
  it("avatar uploads remain unchanged", async () => {
    const { client } = await fixture();
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url).endsWith("/users/me/avatar")).toBe(true);
      expect(
        (init as import("./imageUploadFetch").ImageUploadRequestInit).imageUpload?.image
      ).toEqual(input);
      return new Response(JSON.stringify({ image: { id: "avatar" } }), { status: 201 });
    });
    const api = createLetterApi({
      baseUrl: "https://api.example.com",
      getAccessToken: async () => "token",
      encryption: client,
      fetchImpl,
    });
    await api.uploadImage(input, true, vi.fn());
    expect(client.prepareImage).not.toHaveBeenCalled();
  });
  it("reads ciphertext through authorization, decrypts it and returns pixels without a disk write", async () => {
    const { client, secret, encrypted } = await fixture();
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init?.headers).toEqual({
        authorization: "Bearer token",
        "x-yishu-content-protocol": "yishu-e2ee-v1",
      });
      return new Response(encrypted.ciphertext as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": "application/octet-stream" },
      });
    });
    const api = createLetterApi({
      baseUrl: "https://api.example.com",
      getAccessToken: async () => "token",
      encryption: client,
      fetchImpl,
    });
    expect(await api.getImageData(secret.id, false, secret)).toBe("data:image/jpeg;base64,/9j/");
  });
  it("maps a legacy server's missing crypto endpoint to an actionable error", async () => {
    const api = createLetterApi({
      baseUrl: "https://api.example.com",
      getAccessToken: async () => "token",
      fetchImpl: async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
    });
    await expect(api.getEncryptionRegistration()).rejects.toMatchObject({
      code: "e2ee_unavailable",
      status: 404,
    });
  });
});

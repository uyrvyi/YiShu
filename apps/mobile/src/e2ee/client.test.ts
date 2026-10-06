import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createIdentity,
  createRecovery,
  publicIdentity,
  encryptLetter,
  decryptImage,
  type IdentityRegistration,
  type PrivateIdentity,
} from "@yishu/shared/e2ee";
const store = vi.hoisted(() => new Map<string, string>());
const native = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  getSize: vi.fn(),
  unsupportedPush: vi.fn(),
}));
vi.mock("react-native", () =>
  Object.defineProperty({ Image: { getSize: native.getSize } }, "PushNotificationIOS", {
    enumerable: true,
    get() {
      native.unsupportedPush();
      throw new Error("native_module_missing_in_expo_go");
    },
  })
);
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  File: class {
    readonly uri: string;
    constructor(...parts: string[]) {
      this.uri = parts.join("/");
    }
    get exists() {
      return native.files.has(this.uri);
    }
    get size() {
      return native.files.get(this.uri)?.length ?? 0;
    }
    async bytes() {
      const bytes = native.files.get(this.uri);
      if (!bytes) throw new Error("missing_mock_file");
      return bytes.slice();
    }
    create() {
      native.files.set(this.uri, new Uint8Array());
    }
    write(bytes: Uint8Array) {
      native.files.set(this.uri, bytes.slice());
    }
    delete() {
      native.files.delete(this.uri);
    }
  },
}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 4,
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));
vi.mock("expo-crypto", () => ({
  getRandomBytesAsync: async (n: number) => new Uint8Array(randomBytes(n)),
}));
import { createEncryptionClient } from "./client";
import type { LetterView } from "../api/letterApi";
const rng = async (n: number) => new Uint8Array(randomBytes(n));
describe("Expo Go encryption lifecycle", () => {
  let generation: number, uid: string, record: IdentityRegistration | null, bob: PrivateIdentity;
  let client: ReturnType<typeof createEncryptionClient>;
  let getKey: ReturnType<typeof vi.fn>;
  let enrollKey: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    store.clear();
    native.files.clear();
    native.unsupportedPush.mockClear();
    native.getSize.mockReset();
    native.getSize.mockImplementation((_uri, success) => success(32, 24));
    generation = 1;
    uid = "12345678";
    record = null;
    bob = await createIdentity("23456789", rng);
    getKey = vi.fn(async () => publicIdentity(bob));
    enrollKey = vi.fn(async (registration: IdentityRegistration) => {
      record = registration;
    });
    client = createEncryptionClient(
      () => ({
        getCurrentUser: async () => ({ uid }),
        getEncryptionRegistration: async () => record,
        getEncryptionKey: getKey,
        enrollEncryption: enrollKey,
      }),
      "test",
      () => generation
    );
  });
  async function enroll() {
    const draft = await client.prepareEnrollment();
    await client.activate(draft.recoveryCode);
    return draft;
  }
  const input = {
    recipient: "23456789",
    content: "你好",
    writtenAt: "2026-10-05T13:00:00.000Z",
    transportType: "HORSE_RELAY" as const,
    clientRequestId: "stable",
    imageIds: [],
  };
  it("retains the manual compatibility path and keeps optional backup only in SecureStore", async () => {
    const draft = await client.prepareEnrollment();
    expect(await client.prepareEnrollment()).toEqual(draft);
    await expect(client.activate("00".repeat(32))).rejects.toThrow("e2ee_wrong_recovery_code");
    expect(record).toBeNull();
    await client.activate(draft.recoveryCode);
    expect((await client.status()).available).toBe(true);
    expect(await client.backupRecoveryCode()).toBe(draft.recoveryCode);
    expect([...store.keys()].some((key) => key.endsWith("pending"))).toBe(false);
  });
  it("uses only Image instead of enumerating React Native's unsupported native-module getters", async () => {
    const source = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import\s*\{\s*Image\s*\}\s*from\s*["']react-native["']/);
    expect(source).not.toMatch(/\bimport\s*\(\s*["']react-native["']/);
    await enroll();
    const original = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    native.files.set("file:///input.png", original);
    const prepared = await client.prepareImage({
      uri: "file:///input.png",
      name: "input.png",
      mimeType: "image/png",
    });
    const ciphertext = native.files.get(prepared.input.uri);
    if (!ciphertext) throw new Error("missing_mock_ciphertext");
    expect(prepared.input.mimeType).toBe("application/octet-stream");
    expect(prepared.secret.byteSize).toBe(original.length);
    expect(prepared.secret.width).toBe(32);
    expect(prepared.secret.height).toBe(24);
    expect(ciphertext).not.toEqual(original);
    expect(
      decryptImage(ciphertext, {
        ...prepared.secret,
        id: "11111111-1111-4111-8111-111111111111",
      })
    ).toEqual(original);
    expect(native.unsupportedPush).not.toHaveBeenCalled();
    expect(native.getSize).toHaveBeenCalledOnce();
    prepared.cleanup();
    expect(native.files.has(prepared.input.uri)).toBe(false);
    expect(native.files.get("file:///input.png")).toEqual(original);
  });
  it("automatically enrolls and pins the first contact without sending plaintext", async () => {
    const wire = await client.prepareCreate(input);
    expect((await client.status()).available).toBe(true);
    expect([...store.values()]).toContain(bob.keyId);
    await expect(client.verifyContact(bob.uid, "00".repeat(32))).rejects.toThrow(
      "e2ee_fingerprint_mismatch"
    );
    await client.verifyContact(bob.uid, bob.keyId);
    expect(wire).not.toHaveProperty("content");
    expect(wire).not.toHaveProperty("writtenAt");
    expect(JSON.stringify(wire)).not.toContain(input.content);
  });
  it("coalesces automatic setup and keeps the same keys on subsequent logins", async () => {
    await Promise.all([client.ensureReady(), client.ensureReady(), client.ensureReady()]);
    expect(enrollKey).toHaveBeenCalledOnce();
    const first = await client.status();
    const code = await client.backupRecoveryCode();
    client.reset();
    generation++;
    await client.ensureReady();
    expect((await client.status()).identity?.keyId).toBe(first.identity?.keyId);
    expect(await client.backupRecoveryCode()).toBe(code);
  });
  it("resumes the same persisted identity after the enrollment response is lost", async () => {
    enrollKey.mockImplementationOnce(async (registration: IdentityRegistration) => {
      record = registration;
      throw new Error("network_unavailable");
    });
    await expect(client.ensureReady()).rejects.toThrow("network_unavailable");
    const first = record;
    client.reset();
    await client.ensureReady();
    expect(record).toEqual(first);
    expect(enrollKey).toHaveBeenCalledOnce();
    expect((await client.status()).available).toBe(true);
    expect(await client.backupRecoveryCode()).toBeTruthy();
  });
  it("retries failed enrollment with identical registration rather than rotating keys", async () => {
    enrollKey.mockRejectedValueOnce(new Error("network_unavailable"));
    await expect(client.ensureReady()).rejects.toThrow("network_unavailable");
    const first = enrollKey.mock.calls[0]?.[0];
    client.reset();
    await client.ensureReady();
    expect(enrollKey.mock.calls[1]?.[0]).toEqual(first);
  });
  it("serializes competing first-contact keys so a second response cannot overwrite the first pin", async () => {
    const alternative = await createIdentity(bob.uid, rng);
    getKey
      .mockResolvedValueOnce(publicIdentity(bob))
      .mockResolvedValueOnce(publicIdentity(alternative));
    const results = await Promise.allSettled([
      client.prepareCreate(input),
      client.prepareCreate({ ...input, clientRequestId: "other" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toBe("e2ee_key_changed");
    expect([...store.values()]).toContain(bob.keyId);
    expect([...store.values()]).not.toContain(alternative.keyId);
  });
  it("never silently replaces an enrolled identity when device keys are missing", async () => {
    await client.ensureReady();
    const original = record;
    store.clear();
    client.reset();
    await expect(client.ensureReady()).rejects.toThrow("e2ee_recovery_required");
    expect(record).toEqual(original);
    expect(store.size).toBe(0);
  });
  it("preserves a local identity if its completed server registration disappears", async () => {
    await client.ensureReady();
    const before = [...store.entries()];
    record = null;
    client.reset();
    await expect(client.ensureReady()).rejects.toThrow("e2ee_registration_missing");
    expect([...store.entries()]).toEqual(before);
    expect(enrollKey).toHaveBeenCalledOnce();
  });
  it("pins first incoming contacts only after successful authenticated decryption", async () => {
    const draft = await enroll();
    const packet = await encryptLetter(
      bob,
      draft.identity,
      { content: "自动解密", writtenAt: input.writtenAt, images: [] },
      "incoming-auto",
      "HAND_CARRY",
      rng
    );
    const letter = {
      contentVersion: "yishu-e2ee-v1",
      e2ee: packet,
      sender: { uid: bob.uid },
      recipient: { uid },
      status: "DELIVERED",
      initialTransport: "HAND_CARRY",
    } as LetterView;
    const invalid = await client.decodeLetter({
      ...letter,
      e2ee: { ...packet, signature: "00".repeat(64) },
    });
    expect(invalid.content).toBeNull();
    expect([...store.values()]).not.toContain(bob.keyId);
    expect((await client.decodeLetter(letter)).content).toBe("自动解密");
    expect([...store.values()]).toContain(bob.keyId);
  });
  it("two automatically enrolled clients send and read encrypted text, time and an image without entering codes", async () => {
    let recipientRecord: IdentityRegistration | null = null;
    const receiver = createEncryptionClient(
      () => ({
        getCurrentUser: async () => ({ uid: bob.uid }),
        getEncryptionRegistration: async () => recipientRecord,
        getEncryptionKey: async () => {
          if (!record) throw new Error("sender_not_ready");
          return record.identity;
        },
        enrollEncryption: async (registration) => {
          recipientRecord = registration;
        },
      }),
      "test",
      () => generation
    );
    await receiver.ensureReady();
    getKey.mockImplementation(async () => {
      if (!recipientRecord) throw new Error("recipient_not_ready");
      return recipientRecord.identity;
    });
    const original = new Uint8Array([255, 216, 255, 1, 2, 3]);
    native.files.set("file:///photo.jpg", original);
    const image = await client.prepareImage({
      uri: "file:///photo.jpg",
      name: "photo.jpg",
      mimeType: "image/jpeg",
    });
    const secret = { ...image.secret, id: "11111111-1111-4111-8111-111111111111" };
    const wire = await client.prepareCreate({
      ...input,
      imageIds: [secret.id],
      encryptedImages: [secret],
    });
    const incoming = {
      contentVersion: "yishu-e2ee-v1",
      e2ee: wire.e2ee,
      sender: { uid },
      recipient: { uid: bob.uid },
      status: "IN_TRANSIT",
      initialTransport: "HORSE_RELAY",
    } as LetterView;
    const hidden = await receiver.decodeLetter(incoming);
    expect(hidden.content).toBeNull();
    expect(hidden.writtenAt).toBeNull();
    expect(hidden.images).toEqual([]);
    const received = await receiver.decodeLetter({ ...incoming, status: "DELIVERED" });
    expect(received.content).toBe(input.content);
    expect(received.writtenAt).toBe(input.writtenAt);
    const encryption = received.images?.[0]?.encryption;
    const ciphertext = native.files.get(image.input.uri);
    if (!encryption || !ciphertext) throw new Error("missing encrypted image fixture");
    expect(await receiver.decodeImage(ciphertext, encryption)).toEqual(original);
    expect(JSON.stringify(wire)).not.toContain(input.content);
    expect(JSON.stringify(wire)).not.toContain(secret.key);
    image.cleanup();
  });
  it("retries byte-identical ciphertext for an idempotency key and refuses a changed request", async () => {
    await enroll();
    await client.verifyContact(bob.uid, bob.keyId);
    const first = await client.prepareCreate(input),
      retry = await client.prepareCreate(input);
    expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
    await expect(client.prepareCreate({ ...input, content: "变更" })).rejects.toThrow(
      "idempotency_conflict"
    );
  });
  it("stops when a contact key changes", async () => {
    await enroll();
    await client.verifyContact(bob.uid, bob.keyId);
    bob = await createIdentity(bob.uid, rng);
    await expect(client.prepareCreate(input)).rejects.toThrow("e2ee_key_changed");
  });
  it("coalesces simultaneous retries into one ciphertext without an imageIds serialization change", async () => {
    await enroll();
    await client.verifyContact(bob.uid, bob.keyId);
    const withoutImages = { ...input, imageIds: undefined };
    const [one, two] = await Promise.all([
      client.prepareCreate(withoutImages),
      client.prepareCreate(withoutImages),
    ]);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(JSON.stringify(await client.prepareCreate(withoutImages))).toBe(JSON.stringify(one));
  });
  it("rejects unknown protocol versions instead of treating them as plaintext", async () => {
    const letter = {
      contentVersion: "yishu-e2ee-v99",
      content: "untrusted",
      writtenAt: input.writtenAt,
      images: [],
    } as unknown as LetterView;
    const result = await client.decodeLetter(letter);
    expect(result.content).toBeNull();
    expect(result.decryptionError).toBe("e2ee_unknown_version");
  });
  it("rejects business transport that contradicts the signed envelope", async () => {
    await enroll();
    await client.verifyContact(bob.uid, bob.keyId);
    const wire = await client.prepareCreate(input);
    const letter = {
      contentVersion: "yishu-e2ee-v1",
      e2ee: wire.e2ee,
      sender: { uid },
      recipient: { uid: bob.uid },
      status: "IN_TRANSIT",
      initialTransport: "HAND_CARRY",
    } as LetterView;
    const result = await client.decodeLetter(letter);
    expect(result.content).toBeNull();
    expect(result.decryptionError).toBe("e2ee_invalid_envelope");
  });
  it("rejects image decryption bound to a previous session even if the new account has keys", async () => {
    await enroll();
    generation++;
    await expect(client.decodeImage(new Uint8Array(), {} as never, generation - 1)).rejects.toThrow(
      "e2ee_session_changed"
    );
  });
  it("recovers the original identity without allowing a wrong recovery code to overwrite keys", async () => {
    const draft = await enroll();
    store.clear();
    expect((await client.status()).available).toBe(false);
    await expect(client.recover("00".repeat(32))).rejects.toThrow("e2ee_wrong_recovery_code");
    expect(store.size).toBe(0);
    await client.recover(draft.recoveryCode);
    expect((await client.status()).identity?.keyId).toBe(draft.identity.keyId);
  });
  it("rejects responses after account changes and isolates permanent keys by account", async () => {
    await enroll();
    await client.verifyContact(bob.uid, bob.keyId);
    getKey.mockImplementationOnce(async () => {
      generation++;
      return publicIdentity(bob);
    });
    await expect(client.prepareCreate(input)).rejects.toThrow("e2ee_session_changed");
    uid = bob.uid;
    record = (await createRecovery(bob, rng)).registration;
    expect((await client.status()).available).toBe(false);
  });
  it("never decrypts an undelivered recipient letter even if a server accidentally supplies its envelope", async () => {
    const draft = await enroll();
    await client.verifyContact(bob.uid, bob.keyId);
    const packet = await encryptLetter(
      bob,
      draft.identity,
      { content: "未送达", writtenAt: input.writtenAt, images: [] },
      "incoming",
      "HAND_CARRY",
      rng
    );
    const letter = {
      trackingNo: "YS-20261005-ABCDE",
      contentVersion: "yishu-e2ee-v1",
      initialTransport: "HAND_CARRY",
      status: "IN_TRANSIT",
      content: "must hide",
      writtenAt: input.writtenAt,
      images: [],
      e2ee: packet,
      sender: { uid: bob.uid },
      recipient: { uid: draft.identity.uid },
    } as unknown as LetterView;
    expect((await client.decodeLetter(letter)).content).toBeNull();
    const delivered = await client.decodeLetter({ ...letter, status: "DELIVERED" });
    expect(delivered.content).toBe("未送达");
    expect(delivered.writtenAt).toBe(input.writtenAt);
  });
});

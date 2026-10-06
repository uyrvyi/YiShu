import { describe, expect, it } from "vitest";
import { randomBytes, createPublicKey, verify } from "node:crypto";
import {
  createIdentity,
  createRecovery,
  restoreIdentity,
  publicIdentity,
  encryptLetter,
  decryptLetter,
  verifyLetter,
  verifyRegistration,
  encryptImage,
  decryptImage,
  type ImageSecret,
} from "./e2ee.js";

const rng = async (n: number) => new Uint8Array(randomBytes(n));
const flip = (value: string) =>
  (parseInt(value.slice(0, 2), 16) ^ 1).toString(16).padStart(2, "0") + value.slice(2);
const plain = {
  content: "正文与时间只在双方设备出现",
  writtenAt: "2026-10-05T13:00:00.000Z",
  images: [],
};
describe("E2EE independent letter envelopes", () => {
  it("both endpoints decrypt, a third identity cannot, ciphertext contains no plaintext", async () => {
    const a = await createIdentity("12345678", rng),
      b = await createIdentity("23456789", rng),
      c = await createIdentity("34567890", rng);
    const packet = await encryptLetter(a, publicIdentity(b), plain, "one", "HORSE_RELAY", rng);
    expect(decryptLetter(a, packet)).toEqual(plain);
    expect(decryptLetter(b, packet)).toEqual(plain);
    expect(() => decryptLetter(c, packet)).toThrow();
    expect(JSON.stringify(packet)).not.toContain(plain.content);
    expect(JSON.stringify(packet)).not.toContain(plain.writtenAt);
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(a.signingKey, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    // A separate implementation verifies the identity's Ed25519 signature.
    const recovery = await createRecovery(a, rng);
    const record = recovery.registration;
    const signed = JSON.stringify([
      "yishu-e2ee-v1",
      "enroll",
      publicIdentity(a),
      record.backup.nonce,
      record.backup.ciphertext,
    ]);
    expect(verify(null, Buffer.from(signed), key, Buffer.from(record.proof, "hex"))).toBe(true);
  });
  it("rejects modifications to content, nonce, keys, identities, image order and request context", async () => {
    const a = await createIdentity("12345678", rng),
      b = await createIdentity("23456789", rng);
    const original = await encryptLetter(a, b, plain, "same", "HAND_CARRY", rng);
    for (const mutate of [
      (p: typeof original) => {
        p.payload.ciphertext = flip(p.payload.ciphertext);
      },
      (p: typeof original) => {
        p.payload.nonce = "ff".repeat(24);
      },
      (p: typeof original) => {
        p.recipientWrap.ciphertext = flip(p.recipientWrap.ciphertext);
      },
      (p: typeof original) => {
        p.sender.uid = "45678901";
      },
      (p: typeof original) => {
        p.clientRequestId = "other";
      },
      (p: typeof original) => {
        p.transportType = "PIGEON";
      },
      (p: typeof original) => {
        p.imageIds = ["11111111-1111-4111-8111-111111111111"];
      },
    ]) {
      const packet = structuredClone(original);
      mutate(packet);
      expect(verifyLetter(packet)).toBe(false);
      expect(() => decryptLetter(b, packet)).toThrow();
    }
  });
  it("restores exactly the same private identity, rejecting wrong code, account substitution or backup tampering", async () => {
    const a = await createIdentity("12345678", rng);
    const backup = await createRecovery(a, rng);
    expect(verifyRegistration(backup.registration)).toBe(true);
    expect(restoreIdentity(backup.registration, backup.recoveryCode)).toEqual(a);
    expect(() => restoreIdentity(backup.registration, "00".repeat(32))).toThrow(
      "e2ee_wrong_recovery_code"
    );
    const modified = structuredClone(backup.registration);
    modified.identity.uid = "23456789";
    expect(verifyRegistration(modified)).toBe(false);
    expect(() => restoreIdentity(modified, backup.recoveryCode)).toThrow();
    const changed = structuredClone(backup.registration);
    changed.backup.ciphertext = flip(changed.backup.ciphertext);
    expect(verifyRegistration(changed)).toBe(false);
  });
  it("authenticates each image independently, including empty and oversized input rejection", async () => {
    const source = new Uint8Array(randomBytes(100000));
    const encrypted = await encryptImage(source, rng);
    const secret: ImageSecret = {
      id: "11111111-1111-4111-8111-111111111111",
      key: encrypted.key,
      token: encrypted.token,
      digest: encrypted.digest,
      mimeType: "image/jpeg",
      width: 100,
      height: 100,
      byteSize: source.length,
    };
    expect(decryptImage(encrypted.ciphertext, secret)).toEqual(source);
    expect(() =>
      decryptImage(encrypted.ciphertext, { ...secret, token: "00".repeat(32) })
    ).toThrow();
    encrypted.ciphertext[30] = (encrypted.ciphertext[30] ?? 0) ^ 1;
    expect(() => decryptImage(encrypted.ciphertext, secret)).toThrow();
    await expect(encryptImage(new Uint8Array(), rng)).rejects.toThrow();
    await expect(encryptImage(new Uint8Array(10 * 1024 * 1024 + 1), rng)).rejects.toThrow();
  });
  it("uses fresh independent keys/nonces and refuses an invalid random provider", async () => {
    const a = await createIdentity("12345678", rng),
      b = await createIdentity("23456789", rng);
    const one = await encryptLetter(a, b, plain, "same", "HAND_CARRY", rng);
    const two = await encryptLetter(a, b, plain, "same", "HAND_CARRY", rng);
    expect(one.payload).not.toEqual(two.payload);
    expect(one.recipientWrap).not.toEqual(two.recipientWrap);
    await expect(createIdentity("12345678", async () => new Uint8Array())).rejects.toThrow(
      "e2ee_random_unavailable"
    );
  });
});

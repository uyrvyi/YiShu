import { z } from "zod";
import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from "@noble/hashes/utils.js";

export const E2EE_VERSION = "yishu-e2ee-v1" as const;
export function encryptionStorageNamespace(endpoint: string): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify([E2EE_VERSION, "storage", endpoint]))));
}
const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
const uid = z.string().regex(/^[1-9][0-9]{7}$/);
export const publicIdentitySchema = z
  .object({
    uid,
    keyId: hex(32),
    encryptionKey: hex(32),
    signingKey: hex(32),
  })
  .strict();
export type PublicIdentity = z.infer<typeof publicIdentitySchema>;
export interface PrivateIdentity extends PublicIdentity {
  encryptionSecret: string;
  signingSecret: string;
}
export type RandomBytes = (length: number) => Promise<Uint8Array>;
const blobSchema = z
  .object({
    nonce: hex(24),
    ciphertext: z
      .string()
      .regex(/^[0-9a-f]+$/)
      .min(32)
      .max(131072),
  })
  .strict();
const wrapSchema = blobSchema.extend({ ephemeralKey: hex(32) }).strict();
export const encryptedLetterSchema = z
  .object({
    version: z.literal(E2EE_VERSION),
    sender: publicIdentitySchema,
    recipient: publicIdentitySchema,
    clientRequestId: z.string().min(1).max(64),
    transportType: z.enum(["HAND_CARRY", "HORSE_RELAY", "EXPRESS_RELAY", "PIGEON"]),
    imageIds: z
      .array(z.string().uuid())
      .max(9)
      .refine((ids) => new Set(ids).size === ids.length),
    payload: blobSchema,
    senderWrap: wrapSchema,
    recipientWrap: wrapSchema,
    signature: hex(64),
  })
  .strict();
export type EncryptedLetter = z.infer<typeof encryptedLetterSchema>;
export const identityRegistrationSchema = z
  .object({
    identity: publicIdentitySchema,
    backup: blobSchema,
    proof: hex(64),
  })
  .strict();
export type IdentityRegistration = z.infer<typeof identityRegistrationSchema>;
export const imageSecretSchema = z
  .object({
    id: z.string().uuid(),
    key: hex(32),
    token: hex(32),
    digest: hex(32),
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]),
    width: z.number().int().positive().max(64000000),
    height: z.number().int().positive().max(64000000),
    byteSize: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024),
  })
  .strict()
  .refine((image) => image.width * image.height <= 64000000);
export type ImageSecret = z.infer<typeof imageSecretSchema>;
export const letterPlaintextSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .refine((v) => Array.from(v).length <= 2000),
    writtenAt: z.string().datetime(),
    images: z.array(imageSecretSchema).max(9),
  })
  .strict();
export type LetterPlaintext = z.infer<typeof letterPlaintextSchema>;

function encode(value: unknown): Uint8Array {
  return utf8ToBytes(JSON.stringify(value));
}
function decode(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function publicIdentity(identity: PrivateIdentity | PublicIdentity): PublicIdentity {
  return {
    uid: identity.uid,
    keyId: identity.keyId,
    encryptionKey: identity.encryptionKey,
    signingKey: identity.signingKey,
  };
}
export function identityFingerprint(identity: PublicIdentity): string {
  return bytesToHex(
    sha256(encode([E2EE_VERSION, identity.uid, identity.encryptionKey, identity.signingKey]))
  );
}
export function validIdentity(identity: PublicIdentity): boolean {
  return (
    publicIdentitySchema.safeParse(publicIdentity(identity)).success &&
    identity.keyId === identityFingerprint(identity)
  );
}
async function random(rng: RandomBytes, length: number): Promise<Uint8Array> {
  const bytes = await rng(length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length)
    throw new Error("e2ee_random_unavailable");
  return bytes;
}
export async function createIdentity(userUid: string, rng: RandomBytes): Promise<PrivateIdentity> {
  uid.parse(userUid);
  const encryptionSecret = await random(rng, 32);
  const signingSecret = await random(rng, 32);
  const identity = {
    uid: userUid,
    keyId: "",
    encryptionKey: bytesToHex(x25519.getPublicKey(encryptionSecret)),
    signingKey: bytesToHex(ed25519.getPublicKey(signingSecret)),
  };
  identity.keyId = identityFingerprint(identity);
  return {
    ...identity,
    encryptionSecret: bytesToHex(encryptionSecret),
    signingSecret: bytesToHex(signingSecret),
  };
}
export function validatePrivateIdentity(value: unknown): PrivateIdentity {
  const parsed = publicIdentitySchema
    .extend({ encryptionSecret: hex(32), signingSecret: hex(32) })
    .strict()
    .parse(value);
  if (
    !validIdentity(parsed) ||
    bytesToHex(x25519.getPublicKey(hexToBytes(parsed.encryptionSecret))) !== parsed.encryptionKey ||
    bytesToHex(ed25519.getPublicKey(hexToBytes(parsed.signingSecret))) !== parsed.signingKey
  )
    throw new Error("e2ee_invalid_identity");
  return parsed;
}
async function seal(key: Uint8Array, plain: Uint8Array, aad: Uint8Array, rng: RandomBytes) {
  const nonce = await random(rng, 24);
  return {
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(xchacha20poly1305(key, nonce, aad).encrypt(plain)),
  };
}
function open(key: Uint8Array, blob: z.infer<typeof blobSchema>, aad: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, hexToBytes(blob.nonce), aad).decrypt(hexToBytes(blob.ciphertext));
}
function registrationBytes(record: Omit<IdentityRegistration, "proof">): Uint8Array {
  return encode([
    E2EE_VERSION,
    "enroll",
    publicIdentity(record.identity),
    record.backup.nonce,
    record.backup.ciphertext,
  ]);
}
export async function createRecovery(identity: PrivateIdentity, rng: RandomBytes) {
  const key = await random(rng, 32);
  const pub = publicIdentity(identity);
  const backup = await seal(key, encode(identity), encode([E2EE_VERSION, "backup", pub]), rng);
  const record = { identity: pub, backup };
  return {
    recoveryCode: Array.from({ length: 8 }, (_, index) =>
      bytesToHex(key).slice(index * 8, index * 8 + 8)
    ).join("-"),
    registration: {
      ...record,
      proof: bytesToHex(
        ed25519.sign(registrationBytes(record), hexToBytes(identity.signingSecret))
      ),
    },
  };
}
export function verifyRegistration(record: IdentityRegistration): boolean {
  try {
    return (
      validIdentity(record.identity) &&
      ed25519.verify(
        hexToBytes(record.proof),
        registrationBytes(record),
        hexToBytes(record.identity.signingKey),
        { zip215: false }
      )
    );
  } catch {
    return false;
  }
}
export function restoreIdentity(
  record: IdentityRegistration,
  recoveryCode: string
): PrivateIdentity {
  identityRegistrationSchema.parse(record);
  if (!verifyRegistration(record)) throw new Error("e2ee_invalid_identity");
  const normalized = recoveryCode.toLowerCase().replace(/[-\s]/g, "");
  if (!hex(32).safeParse(normalized).success) throw new Error("e2ee_wrong_recovery_code");
  const key = hexToBytes(normalized);
  let privateKey: PrivateIdentity;
  try {
    privateKey = validatePrivateIdentity(
      decode(
        open(key, record.backup, encode([E2EE_VERSION, "backup", publicIdentity(record.identity)]))
      )
    );
  } catch {
    throw new Error("e2ee_wrong_recovery_code");
  }
  if (
    JSON.stringify(publicIdentity(privateKey)) !== JSON.stringify(publicIdentity(record.identity))
  )
    throw new Error("e2ee_invalid_identity");
  return privateKey;
}
function context(
  packet: Omit<EncryptedLetter, "payload" | "senderWrap" | "recipientWrap" | "signature">
): Uint8Array {
  return encode([
    packet.version,
    publicIdentity(packet.sender),
    publicIdentity(packet.recipient),
    packet.clientRequestId,
    packet.transportType,
    packet.imageIds,
  ]);
}
function signatureBytes(packet: Omit<EncryptedLetter, "signature">): Uint8Array {
  return encode([
    bytesToHex(context(packet)),
    packet.payload.nonce,
    packet.payload.ciphertext,
    packet.senderWrap.ephemeralKey,
    packet.senderWrap.nonce,
    packet.senderWrap.ciphertext,
    packet.recipientWrap.ephemeralKey,
    packet.recipientWrap.nonce,
    packet.recipientWrap.ciphertext,
  ]);
}
function wrapKey(
  shared: Uint8Array,
  ephemeral: string,
  target: PublicIdentity,
  aad: Uint8Array
): Uint8Array {
  return hkdf(
    sha256,
    shared,
    sha256(aad),
    encode([E2EE_VERSION, "wrap", ephemeral, target.keyId]),
    32
  );
}
async function wrap(key: Uint8Array, target: PublicIdentity, aad: Uint8Array, rng: RandomBytes) {
  const ephemeralSecret = await random(rng, 32);
  try {
    const ephemeralKey = bytesToHex(x25519.getPublicKey(ephemeralSecret));
    const shared = x25519.getSharedSecret(ephemeralSecret, hexToBytes(target.encryptionKey));
    try {
      return {
        ephemeralKey,
        ...(await seal(wrapKey(shared, ephemeralKey, target, aad), key, aad, rng)),
      };
    } finally {
      shared.fill(0);
    }
  } finally {
    ephemeralSecret.fill(0);
  }
}
export async function encryptLetter(
  identity: PrivateIdentity,
  recipient: PublicIdentity,
  input: LetterPlaintext,
  clientRequestId: string,
  transportType: EncryptedLetter["transportType"],
  rng: RandomBytes
): Promise<EncryptedLetter> {
  validatePrivateIdentity(identity);
  if (!validIdentity(recipient)) throw new Error("e2ee_invalid_identity");
  const plain = letterPlaintextSchema.parse(input);
  const header = {
    version: E2EE_VERSION,
    sender: publicIdentity(identity),
    recipient: publicIdentity(recipient),
    clientRequestId,
    transportType,
    imageIds: plain.images.map((image) => image.id),
  };
  const aad = context(header);
  const key = await random(rng, 32);
  try {
    const packet = {
      ...header,
      payload: await seal(key, encode(plain), aad, rng),
      senderWrap: await wrap(key, header.sender, aad, rng),
      recipientWrap: await wrap(key, recipient, aad, rng),
    };
    return encryptedLetterSchema.parse({
      ...packet,
      signature: bytesToHex(
        ed25519.sign(signatureBytes(packet), hexToBytes(identity.signingSecret))
      ),
    });
  } finally {
    key.fill(0);
  }
}
export function verifyLetter(packet: EncryptedLetter): boolean {
  try {
    encryptedLetterSchema.parse(packet);
    return (
      validIdentity(packet.sender) &&
      validIdentity(packet.recipient) &&
      ed25519.verify(
        hexToBytes(packet.signature),
        signatureBytes(packet),
        hexToBytes(packet.sender.signingKey),
        { zip215: false }
      )
    );
  } catch {
    return false;
  }
}
export function decryptLetter(identity: PrivateIdentity, packet: EncryptedLetter): LetterPlaintext {
  if (!verifyLetter(packet)) throw new Error("e2ee_invalid_signature");
  const own = packet.sender.uid === identity.uid ? packet.sender : packet.recipient;
  if (own.uid !== identity.uid || own.keyId !== identity.keyId)
    throw new Error("e2ee_wrong_device_key");
  const wrapped = own === packet.sender ? packet.senderWrap : packet.recipientWrap;
  const aad = context(packet);
  const shared = x25519.getSharedSecret(
    hexToBytes(identity.encryptionSecret),
    hexToBytes(wrapped.ephemeralKey)
  );
  let key: Uint8Array | undefined;
  try {
    key = open(wrapKey(shared, wrapped.ephemeralKey, own, aad), wrapped, aad);
    const plain = letterPlaintextSchema.parse(decode(open(key, packet.payload, aad)));
    if (JSON.stringify(plain.images.map((image) => image.id)) !== JSON.stringify(packet.imageIds))
      throw new Error("e2ee_image_mismatch");
    return plain;
  } finally {
    shared.fill(0);
    key?.fill(0);
  }
}
export async function encryptImage(bytes: Uint8Array, rng: RandomBytes) {
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("image_too_large");
  const key = await random(rng, 32);
  const nonce = await random(rng, 24);
  const token = bytesToHex(await random(rng, 32));
  const ciphertext = concatBytes(
    nonce,
    xchacha20poly1305(key, nonce, encode([E2EE_VERSION, "image", token])).encrypt(bytes)
  );
  return { ciphertext, key: bytesToHex(key), token, digest: bytesToHex(sha256(ciphertext)) };
}
export function decryptImage(bytes: Uint8Array, image: ImageSecret): Uint8Array {
  imageSecretSchema.parse(image);
  if (
    bytes.length < 41 ||
    bytes.length > 10 * 1024 * 1024 + 40 ||
    bytesToHex(sha256(bytes)) !== image.digest
  )
    throw new Error("e2ee_invalid_image");
  const plain = xchacha20poly1305(
    hexToBytes(image.key),
    bytes.subarray(0, 24),
    encode([E2EE_VERSION, "image", image.token])
  ).decrypt(bytes.subarray(24));
  if (plain.length !== image.byteSize) throw new Error("e2ee_invalid_image");
  return plain;
}

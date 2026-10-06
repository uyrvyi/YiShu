import * as SecureStore from "expo-secure-store";
import { Image } from "react-native";
import {
  createIdentity,
  createRecovery,
  restoreIdentity,
  validatePrivateIdentity,
  validIdentity,
  verifyRegistration,
  encryptedLetterSchema,
  encryptLetter,
  decryptLetter,
  encryptImage,
  decryptImage,
  E2EE_VERSION,
  encryptionStorageNamespace,
  type PrivateIdentity,
  type PublicIdentity,
  type IdentityRegistration,
  type ImageSecret,
  type EncryptedLetter,
} from "@yishu/shared/e2ee";
import type { CreateLetterInput, LetterView, UploadImageInput } from "../api/letterApi";

export interface EncryptionTransport {
  getCurrentUser(): Promise<{ uid: string }>;
  getEncryptionRegistration(): Promise<IdentityRegistration | null>;
  getEncryptionKey(uid: string): Promise<PublicIdentity>;
  enrollEncryption(record: IdentityRegistration): Promise<void>;
}
const storageOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
async function getRandomBytesAsync(length: number) {
  const crypto = await import("expo-crypto");
  return crypto.getRandomBytesAsync(length);
}
export function createEncryptionClient(
  transport: () => EncryptionTransport,
  namespace: string,
  sessionVersion: () => number
) {
  const prefix = `yishu.e2ee.${encryptionStorageNamespace(namespace)}`;
  type Wire = {
    recipient: string;
    transportType: CreateLetterInput["transportType"];
    clientRequestId: string;
    imageIds: string[];
    e2ee: EncryptedLetter;
  };
  const requests = new Map<string, { input: string; packet: EncryptedLetter }>();
  const preparing = new Map<string, { input: string; promise: Promise<Wire> }>();
  let ownInFlight: ReturnType<typeof readOwn> | null = null;
  let setupInFlight: Promise<void> | null = null;
  let readyState:
    | (Awaited<ReturnType<typeof readOwn>> & {
        identity: PrivateIdentity;
        record: IdentityRegistration;
      })
    | null = null;
  const contactChecks = new Map<string, Promise<void>>();
  const sameSession = (version: number) => {
    if (version !== sessionVersion()) throw new Error("e2ee_session_changed");
  };
  const key = (uid: string, name: string) => `${prefix}.${uid}.${name}`;
  async function readOwn() {
    const version = sessionVersion();
    const { uid } = await transport().getCurrentUser();
    const record = await transport().getEncryptionRegistration();
    sameSession(version);
    if (record && (record.identity.uid !== uid || !verifyRegistration(record)))
      throw new Error("e2ee_invalid_identity");
    const saved = await SecureStore.getItemAsync(key(uid, "identity"));
    sameSession(version);
    const identity = saved ? validatePrivateIdentity(JSON.parse(saved)) : null;
    if (identity && identity.uid !== uid) throw new Error("e2ee_invalid_identity");
    if (!record && identity) {
      const pending = await SecureStore.getItemAsync(key(uid, "pending"));
      sameSession(version);
      if (!pending) throw new Error("e2ee_registration_missing");
    }
    if (record && (!identity || record.identity.keyId !== identity.keyId))
      return { uid, record, identity: null, version };
    if (record && identity) {
      await SecureStore.deleteItemAsync(key(uid, "pending"));
      sameSession(version);
    }
    return { uid, record, identity: record ? identity : null, version };
  }
  function own() {
    if (ownInFlight) return ownInFlight;
    const pending = readOwn().finally(() => {
      if (ownInFlight === pending) ownInFlight = null;
    });
    return (ownInFlight = pending);
  }
  async function requireIdentity() {
    await ensureReady();
    if (!readyState) throw new Error("e2ee_recovery_required");
    sameSession(readyState.version);
    return readyState;
  }
  async function checkContact(
    ownerUid: string,
    identity: PublicIdentity,
    version: number,
    verified = false
  ) {
    if (!validIdentity(identity)) throw new Error("e2ee_invalid_identity");
    if (ownerUid === identity.uid) return;
    const contactKey = key(ownerUid, `contact.${identity.uid}`);
    const previous = contactChecks.get(contactKey);
    const checking = (async () => {
      if (previous) await previous.catch(() => undefined);
      sameSession(version);
      const pinned = await SecureStore.getItemAsync(contactKey);
      sameSession(version);
      if (pinned && pinned !== identity.keyId && !verified) throw new Error("e2ee_key_changed");
      if (!pinned || (verified && pinned !== identity.keyId)) {
        // TOFU: first contact trusts the relay; later changes never overwrite a pin silently.
        await SecureStore.setItemAsync(contactKey, identity.keyId, storageOptions);
        sameSession(version);
      }
    })();
    contactChecks.set(contactKey, checking);
    try {
      await checking;
    } finally {
      if (contactChecks.get(contactKey) === checking) contactChecks.delete(contactKey);
    }
  }
  function ensureReady(): Promise<void> {
    if (readyState?.version === sessionVersion()) return Promise.resolve();
    if (setupInFlight) return setupInFlight;
    const version = sessionVersion();
    const pending = (async () => {
      const state = await own();
      sameSession(version);
      if (state.record) {
        if (!state.identity) throw new Error("e2ee_recovery_required");
        readyState = { ...state, identity: state.identity, record: state.record };
        return;
      }
      const draft = await client.prepareEnrollment();
      sameSession(version);
      await client.activate(draft.recoveryCode);
      const enrolled = await own();
      sameSession(version);
      if (!enrolled.record || !enrolled.identity) throw new Error("e2ee_recovery_required");
      readyState = { ...enrolled, identity: enrolled.identity, record: enrolled.record };
    })().finally(() => {
      if (setupInFlight === pending) setupInFlight = null;
    });
    return (setupInFlight = pending);
  }
  const client = {
    ensureReady,
    reset() {
      requests.clear();
      preparing.clear();
      ownInFlight = null;
      setupInFlight = null;
      readyState = null;
    },
    async status() {
      const state = await own();
      const backupAvailable = !!(await SecureStore.getItemAsync(key(state.uid, "recovery")));
      sameSession(state.version);
      return {
        uid: state.uid,
        enabled: !!state.record,
        available: !!state.identity,
        identity: state.record?.identity ?? null,
        backupAvailable,
      };
    },
    async prepareEnrollment() {
      const state = await own();
      if (state.record) throw new Error("e2ee_identity_already_exists");
      const pendingKey = key(state.uid, "pending");
      const pending = await SecureStore.getItemAsync(pendingKey);
      sameSession(state.version);
      if (pending)
        return JSON.parse(pending) as {
          identity: PrivateIdentity;
          recoveryCode: string;
          registration: IdentityRegistration;
        };
      const identity = await createIdentity(state.uid, getRandomBytesAsync);
      const recovery = await createRecovery(identity, getRandomBytesAsync);
      sameSession(state.version);
      const draft = { identity, ...recovery };
      await SecureStore.setItemAsync(pendingKey, JSON.stringify(draft), storageOptions);
      sameSession(state.version);
      return draft;
    },
    async activate(recoveryCode: string) {
      const state = await own();
      const pendingKey = key(state.uid, "pending");
      const saved = await SecureStore.getItemAsync(pendingKey);
      if (!saved) throw new Error("e2ee_setup_required");
      const pending = JSON.parse(saved) as { registration: IdentityRegistration };
      const identity = restoreIdentity(pending.registration, recoveryCode);
      if (identity.uid !== state.uid) throw new Error("e2ee_invalid_identity");
      if (state.record && state.record.identity.keyId !== identity.keyId)
        throw new Error("e2ee_identity_already_exists");
      sameSession(state.version);
      // A lost enrollment response must not strand the only private key.
      await SecureStore.setItemAsync(
        key(state.uid, "identity"),
        JSON.stringify(identity),
        storageOptions
      );
      sameSession(state.version);
      await SecureStore.setItemAsync(key(state.uid, "recovery"), recoveryCode, storageOptions);
      sameSession(state.version);
      await transport().enrollEncryption(pending.registration);
      sameSession(state.version);
      await SecureStore.deleteItemAsync(pendingKey);
    },
    async recover(recoveryCode: string) {
      readyState = null;
      const state = await own();
      if (!state.record) throw new Error("e2ee_setup_required");
      const identity = restoreIdentity(state.record, recoveryCode);
      sameSession(state.version);
      await SecureStore.setItemAsync(
        key(state.uid, "identity"),
        JSON.stringify(identity),
        storageOptions
      );
      sameSession(state.version);
      await SecureStore.setItemAsync(key(state.uid, "recovery"), recoveryCode, storageOptions);
      sameSession(state.version);
    },
    async backupRecoveryCode() {
      const state = await requireIdentity();
      const code = await SecureStore.getItemAsync(key(state.uid, "recovery"));
      sameSession(state.version);
      if (!code) throw new Error("e2ee_backup_unavailable");
      restoreIdentity(state.record, code);
      return code;
    },
    async verifyContact(peerUid: string, fingerprint: string) {
      const state = await requireIdentity();
      const peer = await transport().getEncryptionKey(peerUid);
      sameSession(state.version);
      if (
        !validIdentity(peer) ||
        peer.uid !== peerUid ||
        peer.keyId !== fingerprint.toLowerCase().replace(/[-\s]/g, "")
      )
        throw new Error("e2ee_fingerprint_mismatch");
      await checkContact(state.uid, peer, state.version, true);
    },
    async prepareCreate(input: CreateLetterInput) {
      const state = await requireIdentity();
      const requestKey = `${state.uid}:${state.version}:${input.clientRequestId}`;
      const existing = requests.get(requestKey);
      const serial = JSON.stringify(input);
      if (existing) {
        if (existing.input !== serial) throw new Error("idempotency_conflict");
        return {
          recipient: input.recipient,
          transportType: input.transportType,
          clientRequestId: input.clientRequestId,
          imageIds: existing.packet.imageIds,
          e2ee: existing.packet,
        };
      }
      const pending = preparing.get(requestKey);
      if (pending) {
        if (pending.input !== serial) throw new Error("idempotency_conflict");
        return pending.promise;
      }
      const promise = (async (): Promise<Wire> => {
        const recipient = await transport().getEncryptionKey(input.recipient);
        if (recipient.uid !== input.recipient) throw new Error("e2ee_invalid_identity");
        await checkContact(state.uid, recipient, state.version);
        const images = input.encryptedImages ?? [];
        if (
          JSON.stringify(images.map((image) => image.id)) !== JSON.stringify(input.imageIds ?? [])
        )
          throw new Error("e2ee_readd_images");
        const packet = await encryptLetter(
          state.identity,
          recipient,
          {
            content: input.content,
            writtenAt: input.writtenAt ?? new Date().toISOString(),
            images,
          },
          input.clientRequestId,
          input.transportType,
          getRandomBytesAsync
        );
        sameSession(state.version);
        requests.set(requestKey, { input: serial, packet });
        return {
          recipient: recipient.uid,
          transportType: input.transportType,
          clientRequestId: input.clientRequestId,
          imageIds: packet.imageIds,
          e2ee: packet,
        };
      })();
      preparing.set(requestKey, { input: serial, promise });
      try {
        return await promise;
      } finally {
        if (preparing.get(requestKey)?.promise === promise) preparing.delete(requestKey);
      }
    },
    async decodeLetter(letter: LetterView): Promise<LetterView> {
      if (!letter.contentVersion || letter.contentVersion === "server-v1") return letter;
      const hidden = { ...letter, content: null, writtenAt: null, images: [] };
      if (letter.contentVersion !== E2EE_VERSION)
        return { ...hidden, decryptionError: "e2ee_unknown_version" };
      try {
        const state = await requireIdentity();
        if (letter.sender.uid !== state.uid && letter.status !== "DELIVERED") return hidden;
        if (!letter.e2ee) throw new Error("e2ee_missing_envelope");
        const packet = encryptedLetterSchema.parse(letter.e2ee);
        if (
          packet.sender.uid !== letter.sender.uid ||
          packet.recipient.uid !== letter.recipient.uid
        )
          throw new Error("e2ee_invalid_identity");
        if (packet.transportType !== letter.initialTransport)
          throw new Error("e2ee_invalid_envelope");
        const peer = state.uid === packet.sender.uid ? packet.recipient : packet.sender;
        const plain = decryptLetter(state.identity, packet);
        // Authenticate the envelope before trusting a first incoming signing key.
        await checkContact(state.uid, peer, state.version);
        sameSession(state.version);
        return {
          ...hidden,
          content: plain.content,
          writtenAt: plain.writtenAt,
          images: plain.images.map((image) => ({
            ...image,
            url: `/api/v1/media/${image.id}`,
            encryption: image,
          })),
        };
      } catch (error) {
        return {
          ...hidden,
          decryptionError:
            error instanceof Error && error.message.startsWith("e2ee_")
              ? error.message
              : "e2ee_decryption_failed",
        };
      }
    },
    async prepareImage(input: UploadImageInput) {
      const state = await requireIdentity();
      const { File, Paths } = await import("expo-file-system");
      const file = new File(input.uri);
      if (!file.exists || !file.size || file.size > 10 * 1024 * 1024)
        throw new Error("image_too_large");
      const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) =>
        Image.getSize(input.uri, (width, height) => resolve({ width, height }), reject)
      );
      const bytes = await file.bytes();
      const encrypted = await encryptImage(bytes, getRandomBytesAsync);
      bytes.fill(0);
      sameSession(state.version);
      const temporary = new File(Paths.cache, `e2ee-${encrypted.token}.bin`);
      temporary.create();
      temporary.write(encrypted.ciphertext);
      const secret = {
        key: encrypted.key,
        token: encrypted.token,
        digest: encrypted.digest,
        mimeType: input.mimeType as ImageSecret["mimeType"],
        ...dimensions,
        byteSize: file.size,
      };
      return {
        input: { uri: temporary.uri, name: "encrypted.bin", mimeType: "application/octet-stream" },
        secret,
        cleanup: () => {
          try {
            temporary.delete();
          } catch {
            /* Ciphertext only. */
          }
        },
      };
    },
    async decodeImage(bytes: Uint8Array, secret: ImageSecret, version = sessionVersion()) {
      sameSession(version);
      const state = await requireIdentity();
      sameSession(version);
      const plain = decryptImage(bytes, secret);
      sameSession(state.version);
      const ascii = (offset: number, count: number) =>
        String.fromCharCode(...plain.subarray(offset, offset + count));
      const valid =
        secret.mimeType === "image/jpeg"
          ? plain[0] === 255 && plain[1] === 216 && plain[2] === 255
          : secret.mimeType === "image/png"
            ? plain[0] === 137 && ascii(1, 7) === "PNG\r\n\x1a\n"
            : secret.mimeType === "image/gif"
              ? ["GIF87a", "GIF89a"].includes(ascii(0, 6))
              : secret.mimeType === "image/webp"
                ? ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP"
                : ascii(4, 4) === "ftyp" && ["avif", "avis"].includes(ascii(8, 4));
      if (!valid) throw new Error("e2ee_invalid_image");
      return plain;
    },
  };
  return client;
}
export type EncryptionClient = ReturnType<typeof createEncryptionClient>;

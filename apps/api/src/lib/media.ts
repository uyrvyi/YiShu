import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { MediaAsset } from "@yishu/db";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const STAGED_MEDIA_TTL_MS = 24 * 60 * 60 * 1000;
const MAGIC = Buffer.from("YSM1");
const formats: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heif: "image/avif",
};

export class MediaError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 400
  ) {
    super(code);
    this.name = "MediaError";
  }
}

export interface MediaView {
  id: string;
  url: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
}

export function toMediaView(
  asset: Pick<MediaAsset, "id" | "mimeType" | "byteSize" | "width" | "height">
): MediaView {
  return {
    id: asset.id,
    url: `/api/v1/media/${asset.id}`,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    width: asset.width,
    height: asset.height,
  };
}

export async function inspectImage(
  buffer: Buffer
): Promise<{ mimeType: string; width: number; height: number }> {
  if (buffer.length > MAX_IMAGE_BYTES) throw new MediaError("image_too_large", 413);
  if (buffer.length === 0) throw new MediaError("invalid_image", 415);
  try {
    const image = sharp(buffer, { limitInputPixels: 64_000_000, animated: true });
    const metadata = await image.metadata();
    const mimeType = metadata.format ? formats[metadata.format] : undefined;
    if (
      !mimeType ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > 64_000_000 ||
      (metadata.format === "heif" && metadata.compression !== "av1")
    ) {
      throw new Error("unsupported_image");
    }
    // Decode pixels too: a matching signature alone does not make a valid image.
    await image.stats();
    const height = metadata.pageHeight ?? metadata.height;
    return metadata.orientation && metadata.orientation >= 5
      ? { mimeType, width: height, height: metadata.width }
      : { mimeType, width: metadata.width, height };
  } catch {
    throw new MediaError("invalid_image", 415);
  }
}

function filePath(directory: string, id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new MediaError("media_not_found", 404);
  }
  return path.join(directory, `${id}.enc`);
}

function encryptionKey(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("invalid_media_key");
  return Buffer.from(hex, "hex");
}

export async function writeEncryptedMedia(
  directory: string,
  id: string,
  buffer: Buffer,
  keyHex: string
): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyHex), iv);
  cipher.setAAD(Buffer.from(id));
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = filePath(directory, id);
  try {
    await writeFile(filename, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") await rm(filename, { force: true });
    throw error;
  }
}

export async function readEncryptedMedia(
  directory: string,
  id: string,
  keyHex: string
): Promise<Buffer> {
  const buffer = await readFile(filePath(directory, id));
  if (
    buffer.length < 32 ||
    buffer.length > MAX_IMAGE_BYTES + 32 ||
    !buffer.subarray(0, 4).equals(MAGIC)
  ) {
    throw new Error("invalid_media_envelope");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(keyHex), buffer.subarray(4, 16));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(buffer.subarray(16, 32));
  return Buffer.concat([decipher.update(buffer.subarray(32)), decipher.final()]);
}

export async function removeMediaFile(directory: string, id: string): Promise<void> {
  await rm(filePath(directory, id), { force: true });
}

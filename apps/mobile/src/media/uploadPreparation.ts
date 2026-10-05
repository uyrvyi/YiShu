import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { LetterApiError, type UploadImageInput } from "../api/letterApi";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_EDGE = 1600;
export const UPLOAD_JPEG_QUALITY = 0.75;
export const TARGET_JPEG_BYTES = 500 * 1024;
const MIN_JPEG_EDGE = 960;
const MAX_JPEG_ENCODINGS = 3;
const PRESERVED_UPLOAD_EDGE = 2048;
export const AVATAR_JPEG_QUALITY = 0.85;

// Preserve alpha-capable formats conservatively; native ImageRef exposes no alpha metadata.
export function uploadFormat(input: UploadImageInput) {
  const alphaCapable =
    !(/image\/hei[cf]/i.test(input.mimeType) || /\.hei[cf]$/i.test(input.name)) &&
    (/image\/(png|webp|gif|avif)/i.test(input.mimeType) ||
      /\.(png|webp|gif|avif)$/i.test(input.name));
  return alphaCapable
    ? { format: SaveFormat.PNG, mimeType: "image/png", extension: ".png" }
    : { format: SaveFormat.JPEG, mimeType: "image/jpeg", extension: ".jpg" };
}

export async function prepareUploadImage(
  input: UploadImageInput,
  purpose: "letter" | "avatar" = "letter"
): Promise<UploadImageInput> {
  const source = new File(input.uri);
  if (!source.exists || source.size === 0) throw new LetterApiError("invalid_image", 415);
  if (source.size > MAX_IMAGE_BYTES) throw new LetterApiError("image_too_large", 413);
  // Do not silently discard animated GIF frames while optimizing still photographs.
  if (/image\/gif/i.test(input.mimeType) || /\.gif$/i.test(input.name)) return input;
  const context = ImageManipulator.manipulate(input.uri);
  try {
    const original = await context.renderAsync();
    try {
      const longest = Math.max(original.width, original.height);
      if (!Number.isFinite(longest) || Math.min(original.width, original.height) <= 0)
        throw new LetterApiError("invalid_image", 415);
      const output = uploadFormat(input);
      const photo = purpose === "letter" && output.format === SaveFormat.JPEG;
      let edge = Math.min(longest, photo ? MAX_UPLOAD_EDGE : PRESERVED_UPLOAD_EDGE);
      for (let attempt = 0; attempt < MAX_JPEG_ENCODINGS; attempt++) {
        if (edge < longest)
          context.resize(original.width >= original.height ? { width: edge } : { height: edge });
        const image = edge < longest ? await context.renderAsync() : original;
        let uri: string;
        try {
          const saved = await image.saveAsync({
            format: output.format,
            compress: photo ? UPLOAD_JPEG_QUALITY : AVATAR_JPEG_QUALITY,
          });
          uri = saved.uri;
        } finally {
          if (image !== original) image.release();
        }
        const file = new File(uri);
        if (!file.exists || file.size === 0) throw new LetterApiError("invalid_image", 415);
        const size = file.size;
        if (
          !photo ||
          size <= TARGET_JPEG_BYTES ||
          edge <= MIN_JPEG_EDGE ||
          attempt === MAX_JPEG_ENCODINGS - 1
        ) {
          if (size > MAX_IMAGE_BYTES) throw new LetterApiError("image_too_large", 413);
          return {
            uri,
            name: (input.name.replace(/\.[^.]+$/, "") || "image") + output.extension,
            mimeType: output.mimeType,
          };
        }
        // Bound work and resolution; re-encode from the decoded source, never from a saved JPEG.
        edge = Math.max(
          MIN_JPEG_EDGE,
          Math.floor(edge * Math.min(0.85, Math.sqrt(TARGET_JPEG_BYTES / size) * 0.95))
        );
        try {
          file.delete();
        } catch {
          // A disposable cache file must not prevent uploading the smaller result.
        }
      }
      throw new LetterApiError("invalid_image", 415);
    } finally {
      original.release();
    }
  } finally {
    context.release();
  }
}

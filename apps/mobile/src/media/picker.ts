import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import type { UploadImageInput } from "../api/letterApi";
import { LetterApiError } from "../api/letterApi";
import { MAX_IMAGE_BYTES, prepareUploadImage } from "./uploadPreparation";

export { MAX_IMAGE_BYTES } from "./uploadPreparation";

export const MAX_LETTER_IMAGES = 9;
export const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
];

export async function pickImages(
  source: "album" | "files",
  limit: number,
  options: { prepare?: boolean; purpose?: "letter" | "avatar" } = {}
): Promise<UploadImageInput[]> {
  if (limit < 1) return [];
  const result =
    source === "album"
      ? await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          allowsMultipleSelection: limit > 1,
          selectionLimit: limit,
          quality: 1,
          exif: false,
        })
      : await DocumentPicker.getDocumentAsync({
          type: IMAGE_MIME_TYPES,
          multiple: limit > 1,
          copyToCacheDirectory: true,
        });
  if (result.canceled) return [];
  if (result.assets.length > limit) throw new LetterApiError("too_many_images", 400);
  const images: UploadImageInput[] = [];
  for (const asset of result.assets) {
    const file = new File(asset.uri);
    if (!file.exists || file.size === 0) throw new LetterApiError("invalid_image", 415);
    if (file.size > MAX_IMAGE_BYTES) throw new LetterApiError("image_too_large", 413);
    const name = "fileName" in asset ? asset.fileName : "name" in asset ? asset.name : null;
    const filename = name || file.name || "image.jpg";
    const mimeType = asset.mimeType || file.type || "application/octet-stream";
    if (
      !IMAGE_MIME_TYPES.includes(mimeType.toLowerCase()) &&
      !/\.(jpe?g|png|webp|gif|avif|hei[cf])$/i.test(filename)
    ) {
      throw new LetterApiError("invalid_image", 415);
    }
    images.push({ uri: asset.uri, name: filename, mimeType });
  }
  if (options.prepare === false) return images;
  const prepared: UploadImageInput[] = [];
  for (const image of images) prepared.push(await prepareUploadImage(image, options.purpose));
  return prepared;
}

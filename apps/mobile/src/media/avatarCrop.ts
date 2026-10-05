import { File } from "expo-file-system";
import { ImageManipulator } from "expo-image-manipulator";
import type { UploadImageInput } from "../api/letterApi";
import { LetterApiError } from "../api/letterApi";
import { MAX_IMAGE_BYTES, AVATAR_JPEG_QUALITY, uploadFormat } from "./uploadPreparation";

export interface CropImage extends UploadImageInput {
  width: number;
  height: number;
}
export interface CropPosition {
  zoom: number;
  x: number;
  y: number;
}
export const INITIAL_CROP: CropPosition = { zoom: 1, x: 0, y: 0 };

export function cropScale(
  image: Pick<CropImage, "width" | "height">,
  diameter: number,
  zoom: number
) {
  return Math.max(diameter / image.width, diameter / image.height) * zoom;
}

export function constrainCrop(
  image: Pick<CropImage, "width" | "height">,
  diameter: number,
  position: CropPosition
): CropPosition {
  const zoom = Math.max(1, Math.min(5, position.zoom));
  const scale = cropScale(image, diameter, zoom);
  const maxX = Math.max(0, (image.width * scale - diameter) / 2);
  const maxY = Math.max(0, (image.height * scale - diameter) / 2);
  return {
    zoom,
    x: maxX === 0 ? 0 : Math.max(-maxX, Math.min(maxX, position.x)),
    y: maxY === 0 ? 0 : Math.max(-maxY, Math.min(maxY, position.y)),
  };
}

export function cropRectangle(
  image: Pick<CropImage, "width" | "height">,
  diameter: number,
  position: CropPosition
) {
  const bounded = constrainCrop(image, diameter, position);
  const scale = cropScale(image, diameter, bounded.zoom);
  const size = Math.max(1, Math.min(image.width, image.height, Math.floor(diameter / scale)));
  return {
    originX: Math.max(
      0,
      Math.min(image.width - size, Math.round(image.width / 2 - (diameter / 2 + bounded.x) / scale))
    ),
    originY: Math.max(
      0,
      Math.min(
        image.height - size,
        Math.round(image.height / 2 - (diameter / 2 + bounded.y) / scale)
      )
    ),
    width: size,
    height: size,
  };
}

// Normalize orientation before measuring so displayed and exported crop coordinates agree.
export async function prepareAvatar(input: UploadImageInput): Promise<CropImage> {
  const context = ImageManipulator.manipulate(input.uri);
  try {
    const rendered = await context.renderAsync();
    try {
      const output = uploadFormat(input);
      const saved = await rendered.saveAsync({ format: output.format, compress: 0.95 });
      if (new File(saved.uri).size > MAX_IMAGE_BYTES)
        throw new LetterApiError("image_too_large", 413);
      return {
        uri: saved.uri,
        name: "avatar" + output.extension,
        mimeType: output.mimeType,
        width: saved.width,
        height: saved.height,
      };
    } finally {
      rendered.release();
    }
  } finally {
    context.release();
  }
}

export async function exportAvatar(
  image: CropImage,
  diameter: number,
  position: CropPosition
): Promise<UploadImageInput> {
  const rectangle = cropRectangle(image, diameter, position);
  const context = ImageManipulator.manipulate(image.uri);
  try {
    context
      .crop(rectangle)
      .resize({ width: Math.min(1024, rectangle.width), height: Math.min(1024, rectangle.height) });
    const rendered = await context.renderAsync();
    try {
      const output = uploadFormat(image);
      const saved = await rendered.saveAsync({
        format: output.format,
        compress: AVATAR_JPEG_QUALITY,
      });
      if (new File(saved.uri).size > MAX_IMAGE_BYTES)
        throw new LetterApiError("image_too_large", 413);
      return { uri: saved.uri, name: "avatar" + output.extension, mimeType: output.mimeType };
    } finally {
      rendered.release();
    }
  } finally {
    context.release();
  }
}

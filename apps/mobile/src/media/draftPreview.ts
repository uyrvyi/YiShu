import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";

const MAX_PREVIEW_EDGE = 1536;

// Keep draft pixels independent of picker file permissions and original image formats.
export async function prepareDraftPreview(uri: string, preparedMimeType?: string): Promise<string> {
  // Picker JPEGs are already resized and encoded; reuse their pixels without another render.
  if (preparedMimeType === "image/jpeg") {
    const base64 = await new File(uri).base64();
    if (!base64) throw new Error("图片预览生成失败，请重新选择图片。");
    return `data:image/jpeg;base64,${base64}`;
  }
  const context = ImageManipulator.manipulate(uri);
  try {
    const original = await context.renderAsync();
    try {
      const longest = Math.max(original.width, original.height);
      if (longest > MAX_PREVIEW_EDGE) {
        context.resize(
          original.width >= original.height
            ? { width: MAX_PREVIEW_EDGE }
            : { height: MAX_PREVIEW_EDGE }
        );
      }
      const preview = longest > MAX_PREVIEW_EDGE ? await context.renderAsync() : original;
      try {
        const saved = await preview.saveAsync({
          format: SaveFormat.JPEG,
          compress: 0.85,
          base64: true,
        });
        if (!saved.base64) throw new Error("图片预览生成失败，请重新选择图片。");
        return `data:image/jpeg;base64,${saved.base64}`;
      } finally {
        if (preview !== original) preview.release();
      }
    } finally {
      original.release();
    }
  } finally {
    context.release();
  }
}

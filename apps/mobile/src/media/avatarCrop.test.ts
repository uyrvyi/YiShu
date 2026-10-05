import { beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  crop: vi.fn(),
  resize: vi.fn(),
  render: vi.fn(),
  save: vi.fn(),
  imageRelease: vi.fn(),
  contextRelease: vi.fn(),
  size: 100,
}));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    get size() {
      return native.size;
    }
  },
}));
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: vi.fn() }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: vi.fn() }));
vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: {
    manipulate: () => {
      const context = {
        crop: native.crop,
        resize: native.resize,
        renderAsync: native.render,
        release: native.contextRelease,
      };
      native.crop.mockReturnValue(context);
      native.resize.mockReturnValue(context);
      return context;
    },
  },
  SaveFormat: { JPEG: "jpeg", PNG: "png" },
}));
import {
  constrainCrop,
  cropRectangle,
  cropScale,
  INITIAL_CROP,
  prepareAvatar,
  exportAvatar,
} from "./avatarCrop";

beforeEach(() => {
  vi.clearAllMocks();
  native.size = 100;
  native.render.mockResolvedValue({ saveAsync: native.save, release: native.imageRelease });
  native.save.mockResolvedValue({ uri: "file:normalized.jpg", width: 1200, height: 800 });
});

describe("avatar crop geometry", () => {
  it("normalizes orientation, exports the selected square and releases native resources", async () => {
    const image = await prepareAvatar({
      uri: "file:original.jpg",
      name: "photo.jpg",
      mimeType: "image/jpeg",
    });
    expect(image).toMatchObject({ width: 1200, height: 800, mimeType: "image/jpeg" });
    await exportAvatar(image, 320, { zoom: 2, x: 40, y: 0 });
    expect(native.crop).toHaveBeenCalledWith({
      originX: 350,
      originY: 200,
      width: 400,
      height: 400,
    });
    expect(native.resize).toHaveBeenCalledWith({ width: 400, height: 400 });
    expect(native.save).toHaveBeenLastCalledWith({ format: "jpeg", compress: 0.85 });
    expect(native.imageRelease).toHaveBeenCalledTimes(2);
    expect(native.contextRelease).toHaveBeenCalledTimes(2);
  });
  it("preserves PNG transparency through avatar normalization and export", async () => {
    const image = await prepareAvatar({
      uri: "file:alpha.png",
      name: "alpha.png",
      mimeType: "image/png",
    });
    expect(image.mimeType).toBe("image/png");
    const uploaded = await exportAvatar(image, 320, INITIAL_CROP);
    expect(uploaded).toMatchObject({ name: "avatar.png", mimeType: "image/png" });
    expect(native.save).toHaveBeenLastCalledWith({ format: "png", compress: 0.85 });
  });
  it("keeps the 10 MB gate and releases both handles when saving fails", async () => {
    native.size = 11 * 1024 * 1024;
    await expect(
      prepareAvatar({ uri: "file:photo", name: "photo.jpg", mimeType: "image/jpeg" })
    ).rejects.toMatchObject({ code: "image_too_large" });
    expect(native.imageRelease).toHaveBeenCalledOnce();
    expect(native.contextRelease).toHaveBeenCalledOnce();
  });
  it("centers a square crop on landscape and portrait images", () => {
    expect(cropRectangle({ width: 1200, height: 800 }, 320, INITIAL_CROP)).toEqual({
      originX: 200,
      originY: 0,
      width: 800,
      height: 800,
    });
    expect(cropRectangle({ width: 800, height: 1200 }, 320, INITIAL_CROP)).toEqual({
      originX: 0,
      originY: 200,
      width: 800,
      height: 800,
    });
  });
  it("clamps panning and zoom so the circle never exposes empty pixels", () => {
    const image = { width: 1200, height: 800 };
    expect(constrainCrop(image, 320, { zoom: 0.1, x: 999, y: -999 })).toEqual({
      zoom: 1,
      x: 80,
      y: 0,
    });
    expect(constrainCrop(image, 320, { zoom: 99, x: 0, y: 0 }).zoom).toBe(5);
    expect(cropRectangle(image, 320, { zoom: 1, x: 999, y: 0 }).originX).toBe(0);
  });
  it("exports exactly the displayed crop at every aspect ratio and zoom", () => {
    for (const image of [
      { width: 6000, height: 1000 },
      { width: 1000, height: 6000 },
      { width: 301, height: 301 },
      { width: 8, height: 5 },
    ]) {
      for (const diameter of [180, 320, 360]) {
        for (const zoom of [1, 1.3, 2.5, 5]) {
          for (const offset of [-99999, 0, 99999]) {
            const position = constrainCrop(image, diameter, { zoom, x: offset, y: -offset });
            const crop = cropRectangle(image, diameter, position);
            const scale = cropScale(image, diameter, zoom);
            expect(crop.width).toBe(crop.height);
            expect(crop.originX).toBeGreaterThanOrEqual(0);
            expect(crop.originY).toBeGreaterThanOrEqual(0);
            expect(crop.originX + crop.width).toBeLessThanOrEqual(image.width);
            expect(crop.originY + crop.height).toBeLessThanOrEqual(image.height);
            expect((image.width * scale - diameter) / 2).toBeGreaterThanOrEqual(
              Math.abs(position.x) - 0.001
            );
            expect((image.height * scale - diameter) / 2).toBeGreaterThanOrEqual(
              Math.abs(position.y) - 0.001
            );
          }
        }
      }
    }
  });
});

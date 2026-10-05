import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  manipulate: vi.fn(),
  resize: vi.fn(),
  render: vi.fn(),
  save: vi.fn(),
  originalRelease: vi.fn(),
  resizedRelease: vi.fn(),
  contextRelease: vi.fn(),
  delete: vi.fn(),
  sizes: new Map<string, number>(),
}));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    get exists() {
      return native.sizes.has(this.uri);
    }
    get size() {
      return native.sizes.get(this.uri) ?? 0;
    }
    delete() {
      native.delete(this.uri);
    }
  },
}));
vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: native.manipulate },
  SaveFormat: { JPEG: "jpeg", PNG: "png" },
}));
import { MAX_IMAGE_BYTES, TARGET_JPEG_BYTES, prepareUploadImage } from "./uploadPreparation";
const photo = { uri: "file:original", name: "IMG.jpg", mimeType: "image/jpeg" };

beforeEach(() => {
  vi.resetAllMocks();
  native.sizes.clear();
  native.sizes.set(photo.uri, 5 * 1024 * 1024);
  native.sizes.set("file:compressed", 400000);
  native.manipulate.mockReturnValue({
    resize: native.resize,
    renderAsync: native.render,
    release: native.contextRelease,
  });
  native.render.mockResolvedValue({
    width: 800,
    height: 600,
    saveAsync: native.save,
    release: native.originalRelease,
  });
  native.save.mockResolvedValue({ uri: "file:compressed" });
});

describe("upload image optimization", () => {
  it("uploads the generated JPEG rather than the original file", async () => {
    expect(await prepareUploadImage(photo)).toEqual({
      uri: "file:compressed",
      name: "IMG.jpg",
      mimeType: "image/jpeg",
    });
    expect(native.save).toHaveBeenCalledWith({ format: "jpeg", compress: 0.75 });
    expect(native.resize).not.toHaveBeenCalled();
    expect(native.originalRelease).toHaveBeenCalledOnce();
    expect(native.contextRelease).toHaveBeenCalledOnce();
  });
  it.each([
    [6000, 4000, { width: 1600 }],
    [4000, 6000, { height: 1600 }],
  ])("bounds %s x %s images without cropping or upscaling", async (width, height, target) => {
    native.render.mockResolvedValueOnce({ width, height, release: native.originalRelease });
    native.render.mockResolvedValueOnce({ saveAsync: native.save, release: native.resizedRelease });
    await prepareUploadImage(photo);
    expect(native.resize).toHaveBeenCalledWith(target);
    expect(native.resizedRelease).toHaveBeenCalledOnce();
    expect(native.originalRelease).toHaveBeenCalledOnce();
  });
  it.each(["png", "webp", "avif"])("retains potential %s alpha in PNG", async (format) => {
    expect(
      await prepareUploadImage({ ...photo, name: `IMG.${format}`, mimeType: `image/${format}` })
    ).toMatchObject({ name: "IMG.png", mimeType: "image/png" });
    expect(native.save).toHaveBeenCalledWith({ format: "png", compress: 0.85 });
  });
  it("retains the previous 2048-pixel bound for transparent formats", async () => {
    native.render.mockResolvedValueOnce({
      width: 6000,
      height: 4000,
      release: native.originalRelease,
    });
    native.render.mockResolvedValue({ saveAsync: native.save, release: native.resizedRelease });
    await prepareUploadImage({ ...photo, name: "IMG.png", mimeType: "image/png" });
    expect(native.resize).toHaveBeenCalledWith({ width: 2048 });
    expect(native.save).toHaveBeenCalledOnce();
  });
  it("shrinks complex JPEGs towards 500 KB without reducing quality again", async () => {
    native.render.mockResolvedValueOnce({
      width: 6000,
      height: 4000,
      release: native.originalRelease,
    });
    native.render.mockResolvedValue({ saveAsync: native.save, release: native.resizedRelease });
    for (const [index, size] of [900000, 600000, 400000].entries()) {
      const uri = `file:attempt-${index}`;
      native.sizes.set(uri, size);
      native.save.mockResolvedValueOnce({ uri });
    }
    const result = await prepareUploadImage(photo);
    expect(result.uri).toBe("file:attempt-2");
    expect(native.sizes.get(result.uri)).toBeLessThanOrEqual(TARGET_JPEG_BYTES);
    const edges = native.resize.mock.calls.map(([target]) => target.width);
    expect(edges[0]).toBe(1600);
    expect(edges[1]).toBeLessThan(edges[0]);
    expect(edges[2]).toBeLessThan(edges[1]);
    expect(edges[2]).toBeGreaterThanOrEqual(960);
    expect(native.save.mock.calls.map(([options]) => options.compress)).toEqual([0.75, 0.75, 0.75]);
    expect(native.manipulate).toHaveBeenCalledOnce();
    expect(native.delete.mock.calls.map(([uri]) => uri)).toEqual([
      "file:attempt-0",
      "file:attempt-1",
    ]);
    expect(native.resizedRelease).toHaveBeenCalledTimes(3);
  });
  it("treats 500 KB as a target and stops at the 960-pixel floor", async () => {
    native.render.mockResolvedValueOnce({
      width: 6000,
      height: 4000,
      release: native.originalRelease,
    });
    native.render.mockResolvedValue({ saveAsync: native.save, release: native.resizedRelease });
    native.sizes.set("file:large", 2000000);
    native.sizes.set("file:floor", 700000);
    native.save
      .mockResolvedValueOnce({ uri: "file:large" })
      .mockResolvedValueOnce({ uri: "file:floor" });
    expect((await prepareUploadImage(photo)).uri).toBe("file:floor");
    expect(native.resize).toHaveBeenLastCalledWith({ width: 960 });
    expect(native.save).toHaveBeenCalledTimes(2);
  });
  it("still creates the smaller JPEG if disposable cache cleanup fails", async () => {
    native.render.mockResolvedValueOnce({
      width: 6000,
      height: 4000,
      release: native.originalRelease,
    });
    native.render.mockResolvedValue({ saveAsync: native.save, release: native.resizedRelease });
    native.sizes.set("file:large", 900000);
    native.sizes.set("file:small", 400000);
    native.save
      .mockResolvedValueOnce({ uri: "file:large" })
      .mockResolvedValueOnce({ uri: "file:small" });
    native.delete.mockImplementationOnce(() => {
      throw new Error("cache busy");
    });
    expect((await prepareUploadImage(photo)).uri).toBe("file:small");
    expect(native.save).toHaveBeenCalledTimes(2);
  });
  it("caps encoding work at three attempts when JPEGs remain above target", async () => {
    native.render.mockResolvedValueOnce({
      width: 6000,
      height: 4000,
      release: native.originalRelease,
    });
    native.render.mockResolvedValue({ saveAsync: native.save, release: native.resizedRelease });
    native.sizes.set("file:compressed", 600000);
    await prepareUploadImage(photo);
    expect(native.save).toHaveBeenCalledTimes(3);
    expect(native.resize.mock.calls.at(-1)?.[0].width).toBeGreaterThan(960);
  });
  it("preserves avatar source size and quality without adaptive letter compression", async () => {
    native.render.mockResolvedValueOnce({
      width: 6000,
      height: 4000,
      release: native.originalRelease,
    });
    native.render.mockResolvedValue({ saveAsync: native.save, release: native.resizedRelease });
    native.sizes.set("file:compressed", 700000);
    await prepareUploadImage(photo, "avatar");
    expect(native.resize).toHaveBeenCalledWith({ width: 2048 });
    expect(native.save).toHaveBeenCalledOnce();
    expect(native.save).toHaveBeenCalledWith({ format: "jpeg", compress: 0.85 });
  });
  it("releases resources if a later adaptive encode fails", async () => {
    native.render.mockResolvedValueOnce({
      width: 6000,
      height: 4000,
      release: native.originalRelease,
    });
    native.render.mockResolvedValue({ saveAsync: native.save, release: native.resizedRelease });
    native.sizes.set("file:compressed", 900000);
    native.save
      .mockResolvedValueOnce({ uri: "file:compressed" })
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(prepareUploadImage(photo)).rejects.toThrow("disk full");
    expect(native.resizedRelease).toHaveBeenCalledTimes(2);
    expect(native.originalRelease).toHaveBeenCalledOnce();
    expect(native.contextRelease).toHaveBeenCalledOnce();
  });
  it("converts HEIC to JPEG even when fallback file metadata is PNG", async () => {
    expect(
      await prepareUploadImage({ ...photo, name: "IMG.HEIC", mimeType: "image/png" })
    ).toMatchObject({ name: "IMG.jpg", mimeType: "image/jpeg" });
  });
  it("preserves GIF frames instead of silently flattening animation", async () => {
    const gif = { ...photo, name: "IMG.gif", mimeType: "image/gif" };
    expect(await prepareUploadImage(gif)).toBe(gif);
    expect(native.manipulate).not.toHaveBeenCalled();
  });
  it("checks the original 10 MB limit before decoding", async () => {
    native.sizes.set(photo.uri, MAX_IMAGE_BYTES + 1);
    await expect(prepareUploadImage(photo)).rejects.toMatchObject({ code: "image_too_large" });
    expect(native.manipulate).not.toHaveBeenCalled();
  });
  it.each([0, MAX_IMAGE_BYTES + 1])(
    "rejects invalid output size %s without uploading the original",
    async (size) => {
      native.sizes.set("file:compressed", size);
      await expect(prepareUploadImage(photo)).rejects.toMatchObject({
        code: size === 0 ? "invalid_image" : "image_too_large",
      });
      expect(native.originalRelease).toHaveBeenCalledOnce();
      expect(native.contextRelease).toHaveBeenCalledOnce();
    }
  );
  it("releases all handles after save failure", async () => {
    native.render.mockResolvedValueOnce({
      width: 6000,
      height: 4000,
      release: native.originalRelease,
    });
    native.render.mockResolvedValueOnce({ saveAsync: native.save, release: native.resizedRelease });
    native.save.mockRejectedValue(new Error("disk full"));
    await expect(prepareUploadImage(photo)).rejects.toThrow("disk full");
    expect(native.resizedRelease).toHaveBeenCalledOnce();
    expect(native.originalRelease).toHaveBeenCalledOnce();
    expect(native.contextRelease).toHaveBeenCalledOnce();
  });
  it("releases the context if native decoding fails", async () => {
    native.render.mockRejectedValue(new Error("decode failed"));
    await expect(prepareUploadImage(photo)).rejects.toThrow("decode failed");
    expect(native.contextRelease).toHaveBeenCalledOnce();
  });
});

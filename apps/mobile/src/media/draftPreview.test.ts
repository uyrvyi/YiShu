import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  manipulate: vi.fn(),
  resize: vi.fn(),
  render: vi.fn(),
  save: vi.fn(),
  originalRelease: vi.fn(),
  previewRelease: vi.fn(),
  contextRelease: vi.fn(),
  base64: vi.fn(),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    base64 = native.base64;
  },
}));

vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: native.manipulate },
  SaveFormat: { JPEG: "jpeg" },
}));

import { prepareDraftPreview } from "./draftPreview";

beforeEach(() => {
  vi.resetAllMocks();
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
  native.save.mockResolvedValue({ base64: "anBlZw==" });
  native.base64.mockResolvedValue("anBlZw==");
});

describe("draft image pixels", () => {
  it("reuses the prepared JPEG without a second decode, resize or encode", async () => {
    expect(await prepareDraftPreview("file:prepared.jpg", "image/jpeg")).toBe(
      "data:image/jpeg;base64,anBlZw=="
    );
    expect(native.base64).toHaveBeenCalledOnce();
    expect(native.manipulate).not.toHaveBeenCalled();
    expect(native.render).not.toHaveBeenCalled();
    expect(native.save).not.toHaveBeenCalled();
  });
  it("rejects an empty prepared JPEG rather than displaying a blank thumbnail", async () => {
    native.base64.mockResolvedValue("");
    await expect(prepareDraftPreview("file:empty.jpg", "image/jpeg")).rejects.toThrow(
      "图片预览生成失败"
    );
  });
  it("retains independent rendering for non-JPEG previews", async () => {
    await prepareDraftPreview("file:alpha.png", "image/png");
    expect(native.manipulate).toHaveBeenCalledWith("file:alpha.png");
    expect(native.base64).not.toHaveBeenCalled();
  });
  it("generates JPEG data independent of the original temporary file URI", async () => {
    expect(await prepareDraftPreview("file:picker/IMG.heic")).toBe(
      "data:image/jpeg;base64,anBlZw=="
    );
    expect(native.manipulate).toHaveBeenCalledWith("file:picker/IMG.heic");
    expect(native.save).toHaveBeenCalledWith({ format: "jpeg", compress: 0.85, base64: true });
    expect(native.resize).not.toHaveBeenCalled();
    expect(native.originalRelease).toHaveBeenCalledOnce();
    expect(native.contextRelease).toHaveBeenCalledOnce();
  });

  it.each([
    [6000, 4000, { width: 1536 }],
    [4000, 6000, { height: 1536 }],
  ])("bounds large %s x %s previews without cropping", async (width, height, target) => {
    native.render.mockResolvedValueOnce({ width, height, release: native.originalRelease });
    native.render.mockResolvedValueOnce({
      saveAsync: native.save,
      release: native.previewRelease,
    });
    await prepareDraftPreview("file:large.png");
    expect(native.resize).toHaveBeenCalledWith(target);
    expect(native.originalRelease).toHaveBeenCalledOnce();
    expect(native.previewRelease).toHaveBeenCalledOnce();
    expect(native.contextRelease).toHaveBeenCalledOnce();
  });

  it("does not accept an empty preview and releases native resources", async () => {
    native.save.mockResolvedValue({ uri: "file:cached.jpg" });
    await expect(prepareDraftPreview("file:photo")).rejects.toThrow("图片预览生成失败");
    expect(native.originalRelease).toHaveBeenCalledOnce();
    expect(native.contextRelease).toHaveBeenCalledOnce();
  });

  it("releases the context when source decoding fails", async () => {
    native.render.mockRejectedValue(new Error("decode failed"));
    await expect(prepareDraftPreview("file:unreadable")).rejects.toThrow("decode failed");
    expect(native.contextRelease).toHaveBeenCalledOnce();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  album: vi.fn(),
  files: vi.fn(),
  render: vi.fn(),
  resize: vi.fn(),
  save: vi.fn(),
  contextRelease: vi.fn(),
  imageRelease: vi.fn(),
  sizes: new Map<string, number>(),
}));
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: mock.album }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: mock.files }));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    get exists() {
      return mock.sizes.has(this.uri);
    }
    get size() {
      return mock.sizes.get(this.uri) ?? 0;
    }
    name = "photo.png";
    type = "image/png";
  },
}));
vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: {
    manipulate: () => ({
      renderAsync: mock.render,
      resize: mock.resize,
      release: mock.contextRelease,
    }),
  },
  SaveFormat: { JPEG: "jpeg", PNG: "png" },
}));
import { IMAGE_MIME_TYPES, MAX_IMAGE_BYTES, pickImages } from "./picker";

beforeEach(() => {
  vi.clearAllMocks();
  mock.sizes.clear();
  mock.sizes.set("file:photo", 100);
  mock.sizes.set("file:jpeg", 200);
  mock.render.mockResolvedValue({
    width: 800,
    height: 600,
    saveAsync: mock.save,
    release: mock.imageRelease,
  });
  mock.save.mockResolvedValue({ uri: "file:jpeg" });
});
describe("private photo selection", () => {
  it("restricts the file picker to supported raster images and rejects non-images", async () => {
    mock.files.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:photo", name: "document.pdf", mimeType: "application/pdf" }],
    });
    await expect(pickImages("files", 1)).rejects.toMatchObject({ code: "invalid_image" });
    expect(mock.files.mock.calls[0]?.[0].type).not.toContain("image/svg+xml");
  });
  it("cancellation and full drafts do not upload anything", async () => {
    mock.album.mockResolvedValue({ canceled: true });
    expect(await pickImages("album", 9)).toEqual([]);
    expect(await pickImages("files", 0)).toEqual([]);
    expect(mock.files).not.toHaveBeenCalled();
  });
  it("copies file selections to readable cache and uploads optimized image pixels", async () => {
    mock.files.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:photo", name: "letter.png", mimeType: "image/png" }],
    });
    expect(await pickImages("files", 9)).toEqual([
      { uri: "file:jpeg", name: "letter.png", mimeType: "image/png" },
    ]);
    expect(mock.files).toHaveBeenCalledWith({
      type: IMAGE_MIME_TYPES,
      multiple: true,
      copyToCacheDirectory: true,
    });
    expect(mock.save).toHaveBeenCalledWith({ format: "png", compress: 0.85 });
  });
  it("rejects too many files, missing pixels, and originals larger than 10 MB", async () => {
    const asset = { uri: "file:photo", mimeType: "image/png" };
    mock.album.mockResolvedValue({ canceled: false, assets: [asset, asset] });
    await expect(pickImages("album", 1)).rejects.toMatchObject({ code: "too_many_images" });
    mock.album.mockResolvedValue({ canceled: false, assets: [asset] });
    mock.sizes.set(asset.uri, MAX_IMAGE_BYTES + 1);
    await expect(pickImages("album", 1)).rejects.toMatchObject({ code: "image_too_large" });
    mock.sizes.clear();
    await expect(pickImages("album", 1)).rejects.toMatchObject({ code: "invalid_image" });
  });
  it("converts iPhone HEIC file selections to JPEG and releases native handles", async () => {
    mock.files.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:photo", name: "IMG.HEIC", mimeType: "image/heic" }],
    });
    expect(await pickImages("files", 1)).toEqual([
      { uri: "file:jpeg", name: "IMG.jpg", mimeType: "image/jpeg" },
    ]);
    expect(mock.imageRelease).toHaveBeenCalledOnce();
    expect(mock.contextRelease).toHaveBeenCalledOnce();
    expect(mock.save).toHaveBeenCalledWith({ format: "jpeg", compress: 0.75 });
  });
  it("keeps album selection full-quality before the explicit upload optimization", async () => {
    mock.album.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:photo", fileName: "photo.jpg", mimeType: "image/jpeg" }],
    });
    await pickImages("album", 1);
    expect(mock.album).toHaveBeenCalledWith(expect.objectContaining({ quality: 1, exif: false }));
    expect(mock.save).toHaveBeenCalledWith({ format: "jpeg", compress: 0.75 });
  });
  it("also rejects oversized converted JPEGs and still releases native handles", async () => {
    mock.sizes.set("file:jpeg", MAX_IMAGE_BYTES + 1);
    mock.files.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:photo", name: "IMG.HEIC" }],
    });
    await expect(pickImages("files", 1)).rejects.toMatchObject({ code: "image_too_large" });
    expect(mock.imageRelease).toHaveBeenCalledOnce();
    expect(mock.contextRelease).toHaveBeenCalledOnce();
  });
  it("returns validated selections immediately when letter preparation is deferred", async () => {
    mock.album.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:photo", fileName: "IMG.jpg", mimeType: "image/jpeg" }],
    });
    expect(await pickImages("album", 1, { prepare: false })).toEqual([
      { uri: "file:photo", name: "IMG.jpg", mimeType: "image/jpeg" },
    ]);
    expect(mock.render).not.toHaveBeenCalled();
  });
  it("keeps avatar picker JPEG quality at 85%", async () => {
    mock.album.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:photo", fileName: "IMG.jpg", mimeType: "image/jpeg" }],
    });
    await pickImages("album", 1, { purpose: "avatar" });
    expect(mock.save).toHaveBeenCalledWith({ format: "jpeg", compress: 0.85 });
  });
  it("validates the whole deferred batch before allowing any preparation or upload", async () => {
    mock.sizes.set("file:too-large", MAX_IMAGE_BYTES + 1);
    mock.album.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: "file:photo", fileName: "IMG.jpg", mimeType: "image/jpeg" },
        { uri: "file:too-large", fileName: "IMG2.jpg", mimeType: "image/jpeg" },
      ],
    });
    await expect(pickImages("album", 2, { prepare: false })).rejects.toMatchObject({
      code: "image_too_large",
    });
    expect(mock.render).not.toHaveBeenCalled();
  });
});

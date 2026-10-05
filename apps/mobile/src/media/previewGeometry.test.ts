import { describe, expect, it } from "vitest";
import {
  constrainPreview,
  ORIGINAL_PREVIEW,
  previewFrame,
  zoomPreviewAt,
  pinchPreview,
  previewDismissDistance,
} from "./previewGeometry";

describe("full-screen preview geometry", () => {
  it("uses a viewport-relative swipe-dismiss threshold with reasonable limits", () => {
    expect(previewDismissDistance(300)).toBe(80);
    expect(previewDismissDistance(800)).toBe(144);
    expect(previewDismissDistance(2000)).toBe(160);
  });
  it("fits wide and tall images without cropping at the original scale", () => {
    expect(previewFrame(400, 800, 2)).toEqual({ width: 400, height: 200 });
    expect(previewFrame(400, 800, 0.25)).toEqual({ width: 200, height: 800 });
    expect(constrainPreview({ zoom: 1, x: 500, y: -500 }, 400, 800, 2)).toEqual(ORIGINAL_PREVIEW);
  });
  it("enlarges toward the double-tapped point and clamps offsets to the visible image", () => {
    expect(zoomPreviewAt(200, 400, 400, 800, 0.5)).toEqual({ zoom: 2.5, x: 0, y: 0 });
    expect(zoomPreviewAt(0, 0, 400, 800, 0.5)).toEqual({ zoom: 2.5, x: 300, y: 600 });
    expect(constrainPreview({ zoom: 2.5, x: 999, y: -999 }, 400, 800, 2)).toEqual({
      zoom: 2.5,
      x: 300,
      y: 0,
    });
  });
  it("anchors pinch scaling to the fingers and limits zoom to 1-5", () => {
    const initial = { x: 100, y: 300, distance: 100 };
    expect(
      pinchPreview(ORIGINAL_PREVIEW, initial, { ...initial, distance: 200 }, 400, 800, 0.5)
    ).toEqual({
      zoom: 2,
      x: 100,
      y: 100,
    });
    expect(
      pinchPreview(ORIGINAL_PREVIEW, initial, { ...initial, distance: 1000 }, 400, 800, 0.5).zoom
    ).toBe(5);
    expect(
      pinchPreview(
        { zoom: 2, x: 100, y: 100 },
        initial,
        { ...initial, distance: 10 },
        400,
        800,
        0.5
      )
    ).toEqual(ORIGINAL_PREVIEW);
    expect(
      pinchPreview(ORIGINAL_PREVIEW, { ...initial, distance: 0 }, initial, 400, 800, 0.5).zoom
    ).toBe(1);
  });
  it("handles missing metadata and zero-size layouts without NaN", () => {
    expect(previewFrame(400, 800, Number.NaN)).toEqual({ width: 400, height: 400 });
    expect(zoomPreviewAt(0, 0, 0, 0, 0)).toEqual({ zoom: 2.5, x: 0, y: 0 });
  });
});

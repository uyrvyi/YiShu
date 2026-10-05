import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { RouteMapViewParsed } from "@yishu/shared";
import { buildBaiduMapHtml } from "./baiduMapHtml";

// Exercise the generated script with SDK-style camera projection, without network or an AK.
async function render(
  width: number,
  height: number,
  topInset: number,
  single = false,
  conversionStatus = 0
) {
  class Point {
    constructor(
      public lng: number,
      public lat: number
    ) {}
  }
  class Pixel {
    constructor(
      public x: number,
      public y: number
    ) {}
  }
  const point = { x: 800, y: 200 };
  const end = single ? point : { x: 810, y: 202 };
  const view: RouteMapViewParsed = {
    status: "IN_TRANSIT",
    origin: null,
    destination: null,
    completedPath: [point],
    remainingPath: [point, end],
    lastKnownPosition: point,
    approximatePosition: null,
    facts: [],
  };
  const messages: string[] = [];
  const events: Record<string, () => void> = {};
  let zoom = 6,
    center = new Point(0, 0);
  const circles: { radius: number }[] = [];
  const conversions: number[] = [];
  class Map {
    centerAndZoom(value: Point, z: number) {
      center = value;
      zoom = z;
    }
    getSize() {
      return { width, height };
    }
    checkResize() {}
    getMinZoom() {
      return 3;
    }
    getMaxZoom() {
      return 21;
    }
    enableScrollWheelZoom() {}
    addControl() {}
    addOverlay() {}
    getViewport(points: Point[]) {
      return { center: points[0], zoom: 6 };
    }
    pointToPixel(point: Point, camera = { center, zoom }) {
      return new Pixel(
        width / 2 + (point.lng - camera.center.lng) * 2 ** camera.zoom,
        height / 2 - (point.lat - camera.center.lat) * 2 ** camera.zoom
      );
    }
    pixelToPoint(pixel: Pixel, camera = { center, zoom }) {
      return new Point(
        camera.center.lng + (pixel.x - width / 2) / 2 ** camera.zoom,
        camera.center.lat - (pixel.y - height / 2) / 2 ** camera.zoom
      );
    }
    getDistance(a: Point, b: Point) {
      return Math.hypot(a.lng - b.lng, a.lat - b.lat);
    }
    setViewport(camera: { center: Point; zoom: number }) {
      center = camera.center;
      zoom = camera.zoom;
    }
    addEventListener(name: string, callback: () => void) {
      events[name] = callback;
    }
  }
  class Circle {
    radius = 0;
    constructor() {
      circles.push(this);
    }
    setRadius(radius: number) {
      this.radius = radius;
    }
  }
  const html = buildBaiduMapHtml(view, "test", topInset);
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
  if (!script) throw new Error("Missing generated map script");
  class Control {
    constructor(public readonly options?: unknown) {}
  }
  const browserWindow: {
    ReactNativeWebView: { postMessage: (message: string) => void };
    addEventListener: () => void;
    yishuMapReady?: () => void;
  } = {
    ReactNativeWebView: { postMessage: (message) => messages.push(message) },
    addEventListener: () => undefined,
  };
  const appended: { src?: string; onerror?: () => void }[] = [];
  runInNewContext(script, {
    BMap: {
      Point,
      Pixel,
      Map,
      Circle,
      Polyline: Control,
      Size: Control,
      ZoomControl: Control,
      ScaleControl: Control,
      Convertor: class {
        translate(
          points: Point[],
          _from: number,
          _to: number,
          callback: (result: unknown) => void
        ) {
          conversions.push(points.length);
          callback({ status: conversionStatus, points });
        }
      },
    },
    BMAP_ANCHOR_TOP_RIGHT: 1,
    BMAP_ANCHOR_BOTTOM_LEFT: 2,
    window: browserWindow,
    document: {
      createElement: () => ({}),
      body: { appendChild: (script: (typeof appended)[number]) => appended.push(script) },
    },
    requestAnimationFrame: (callback: () => void) => callback(),
  });
  const beforeSdkReady = { messages: [...messages], conversions: [...conversions] };
  browserWindow.yishuMapReady?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  events.firsttileloaded?.();
  const map = new Map();
  return {
    messages,
    events,
    circles,
    zoom,
    conversions,
    beforeSdkReady,
    appended,
    pixels: [new Point(108, 45), new Point(single ? 108 : 111.6, single ? 45 : 44.55)].map((p) =>
      map.pointToPixel(p)
    ),
  };
}

describe("百度地图取景", () => {
  it.each([
    [320, 256, 18],
    [390, 312, 92],
    [680, 544, 92],
    [320, 480, 92],
  ])("%s x %s 避开 %s 高提示栏和地图控件，同时紧贴可用范围", async (w, h, top) => {
    const { pixels, messages, zoom, circles, events } = await render(w, h, top);
    expect(messages).toEqual([
      "stage:document",
      "stage:conversion",
      "stage:layout",
      "stage:tiles",
      "ready",
    ]);
    for (const p of pixels) {
      expect(p.x).toBeGreaterThanOrEqual(18 - 0.01);
      expect(p.x).toBeLessThanOrEqual(w - 52 + 0.01);
      expect(p.y).toBeGreaterThanOrEqual(top - 0.01);
      expect(p.y).toBeLessThanOrEqual(h - 32 + 0.01);
    }
    const spanX = Math.abs(pixels[1].x - pixels[0].x),
      spanY = Math.abs(pixels[1].y - pixels[0].y);
    expect(Math.max(spanX / (w - 70), spanY / (h - top - 32))).toBeCloseTo(1);
    expect(zoom % 1).not.toBe(0);
    expect(circles.every((c) => c.radius > 0)).toBe(true);
    expect(events.zoomend).toBeDefined();
    expect(events.resize).toBeDefined();
    expect(events.moveend).toBeUndefined();
  });
  it("单点路线采用有限缩放，不无限放大", async () => {
    expect((await render(390, 312, 18, true)).zoom).toBe(13);
  });
  it("重复起点、轨迹和最新位置只转换一次，转换失败显式回退", async () => {
    expect((await render(390, 312, 18)).conversions).toEqual([2]);
    expect((await render(390, 312, 18, true)).conversions).toEqual([1]);
    expect((await render(390, 312, 18, false, 1)).messages).toContain("error:conversion");
  });
  it("waits for the asynchronous SDK callback before creating a map", async () => {
    const result = await render(390, 312, 18);
    expect(result.beforeSdkReady).toEqual({ messages: ["stage:document"], conversions: [] });
    expect(result.appended[0]?.src).toContain("callback=yishuMapReady");
  });
  it("zero-size SDK container never reports ready", async () => {
    const result = await render(0, 0, 18);
    expect(result.messages).toContain("error:layout");
    expect(result.messages).not.toContain("ready");
  });
});

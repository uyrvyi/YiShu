import { describe, expect, it, vi } from "vitest";
import { lockNorthUp } from "./northUp";
import { buildBaiduMapHtml } from "./baiduMapHtml";

describe("north-up map camera", () => {
  it("locks available rotation and tilt APIs while retaining pan and pinch zoom", () => {
    const map = {
      disableRotate: vi.fn(),
      disableTilt: vi.fn(),
      setHeading: vi.fn(),
      setTilt: vi.fn(),
      enableDragging: vi.fn(),
      enablePinchToZoom: vi.fn(),
    };
    lockNorthUp(map);
    expect(map.disableRotate).toHaveBeenCalledOnce();
    expect(map.disableTilt).toHaveBeenCalledOnce();
    expect(map.setHeading).toHaveBeenCalledWith(0);
    expect(map.setTilt).toHaveBeenCalledWith(0);
    expect(map.enableDragging).toHaveBeenCalledOnce();
    expect(map.enablePinchToZoom).toHaveBeenCalledOnce();
  });
  it("does not crash the already north-up classic SDK if camera APIs are absent", () => {
    expect(() => lockNorthUp({})).not.toThrow();
  });
  it("actually includes the lock in the embedded map without replacing viewport fitting", () => {
    const html = buildBaiduMapHtml(
      {
        status: "CREATED",
        origin: null,
        destination: null,
        completedPath: [],
        remainingPath: [],
        lastKnownPosition: null,
        approximatePosition: null,
        facts: [],
      },
      "test"
    );
    expect(html).toContain("enableRotate: false, enableTilt: false");
    expect(html).toContain("lockNorth(map)");
    expect(html).toContain("map.getViewport");
    expect(html).toContain("map.enableScrollWheelZoom(true)");
  });
});

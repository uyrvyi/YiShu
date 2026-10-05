import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ permission: vi.fn(), position: vi.fn(), reverse: vi.fn() }));
vi.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: mock.permission,
  getCurrentPositionAsync: mock.position,
  reverseGeocodeAsync: mock.reverse,
  Accuracy: { Balanced: 3 },
}));
import { locateRegion } from "./locate";
beforeEach(() => {
  mock.permission.mockReset().mockResolvedValue({ granted: true });
  mock.position.mockReset().mockResolvedValue({ coords: { latitude: 31, longitude: 121 } });
  mock.reverse
    .mockReset()
    .mockResolvedValue([
      { isoCountryCode: "CN", region: "上海市", city: "上海市", district: "徐汇区" },
    ]);
});
afterEach(() => {
  vi.useRealTimers();
});
describe("optional foreground region preselection", () => {
  it("denied permission leaves manual input available without reading location", async () => {
    mock.permission.mockResolvedValue({ granted: false });
    expect(await locateRegion()).toEqual({ error: "denied" });
    expect(mock.position).not.toHaveBeenCalled();
  });
  it("maps real addresses into valid dependent choices", async () => {
    expect(await locateRegion()).toEqual({
      region: { province: "上海市", city: "上海市", district: "徐汇区" },
      partial: false,
    });
  });
  it("unavailable permission APIs and reverse geocoding fail closed to manual input", async () => {
    mock.permission.mockRejectedValue(new Error("unavailable"));
    expect(await locateRegion()).toEqual({ error: "unavailable" });
    mock.permission.mockResolvedValue({ granted: true });
    mock.reverse.mockRejectedValue(new Error("offline"));
    expect(await locateRegion()).toEqual({ error: "unavailable" });
  });
  it("does not hang forever on unavailable GPS", async () => {
    vi.useFakeTimers();
    mock.position.mockImplementation(() => new Promise(() => {}));
    const request = locateRegion();
    await vi.advanceTimersByTimeAsync(15000);
    expect(await request).toEqual({ error: "unavailable" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

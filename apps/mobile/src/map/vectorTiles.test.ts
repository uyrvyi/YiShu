import { describe, expect, it, vi } from "vitest";
import { staticTileConfig, staticTileScript } from "./vectorTiles";
import { buildLocalMapHtml } from "./localMapHtml";
import { WEB_MAP_PALETTES } from "./theme";

describe("versioned self-hosted vector tiles", () => {
  it("theme redraw reuses decoded tiles instead of downloading and decoding them again", async () => {
    const grid = { addTo: vi.fn(), options: {}, _getVectorTilePromise: (_coords: object): Promise<unknown> => Promise.resolve(null) };
    const fetch = vi.fn(async (_url: string) => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0), json: async () => [] }));
    const decoded = vi.fn();
    class VectorTile { layers = {}; constructor() { decoded(); } }
    const container = { classList: { add: vi.fn() }, style: { setProperty: vi.fn() } };
    const map = { getContainer: () => container, attributionControl: { addAttribution: vi.fn() },
      getZoom: () => 8, getPane: () => ({ style: {} }), on: vi.fn() };
    new Function("L", "map", "fetch", "VectorTile", "Pbf", "palette", "unavailable", "detailCandidates", "scheduleLabels", staticTileScript("https://example.com/maps/v1"))(
      { vectorGrid: { protobuf: () => grid }, canvas: { tile: {} } }, map, fetch, VectorTile, class {}, WEB_MAP_PALETTES.light, {}, [], vi.fn());
    const coords = { z: 8, x: 12, y: 13 };
    const first = grid._getVectorTilePromise(coords); await first;
    expect(grid._getVectorTilePromise(coords)).toBe(first);
    expect(decoded).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith(".pbf"))).toHaveLength(1);
  });
  it("keeps offline clients offline until a tile endpoint is explicitly configured", () => {
    expect(staticTileConfig()).toBeNull();
    expect(buildLocalMapHtml()).not.toContain("staticTileBase=");
  });
  it("allows HTTPS and loopback previews, without credentials or arbitrary paths", () => {
    expect(staticTileConfig({ baseUrl: "http://127.0.0.1:4180/maps/national-20261003/" })).toEqual({
      origin: "http://127.0.0.1:4180",
      baseUrl: "http://127.0.0.1:4180/maps/national-20261003",
    });
    expect(staticTileConfig({ baseUrl: "https://example.com/maps/v1" })?.origin).toBe(
      "https://example.com"
    );
    for (const baseUrl of [
      "http://8.136.121.71/maps/v1",
      "https://u:p@example.com/maps/v1",
      "file:///maps/v1",
      "https://example.com/api",
      "https://example.com/maps/v1?token=x",
      "https://example.com/maps/v1#x",
      "https://a;script-src/maps/v1",
      "https://a'b/maps/v1",
    ]) {
      expect(() => staticTileConfig({ baseUrl })).toThrow();
    }
  });
  it("uses one ordered grid, draws boundaries after waters, and preserves business overlays", () => {
    const html = buildLocalMapHtml({ baseUrl: "http://127.0.0.1:4180/maps/national-20261003" });
    expect(html).toContain("connect-src http://127.0.0.1:4180");
    expect(html).toContain("maxNativeZoom:12");
    expect(html).toContain("rendererFactory:L.canvas.tile");
    expect(html).toContain("maxZoom:15");
    expect(html).toContain("['water','road','coastline','boundary']");
    expect(html).toContain("p.kind==='motorway'||p.kind==='trunk'");
    expect(html).toContain("credentials:'omit'");
    expect(html).toContain("var requestDetails=function(){scheduleLabels();return;");
    expect(html).toContain("window.yishuMapDetails=function(payload){return;");
    expect(html).toContain("if(first)");
    expect(html).toContain("view.segments");
    expect(html).toContain("THE BEER-WARE LICENSE");
    expect(staticTileScript("https://example.com/maps/v1")).not.toContain("api.map.baidu.com");
  });
});

import { describe, expect, it } from "vitest";
import { staticTileConfig, staticTileScript } from "./vectorTiles";
import { buildLocalMapHtml } from "./localMapHtml";

describe("versioned self-hosted vector tiles", () => {
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

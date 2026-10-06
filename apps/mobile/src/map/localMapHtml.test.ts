import { describe, expect, it, vi } from "vitest";
import { buildLocalMapHtml, mapUpdateScript } from "./localMapHtml";
import type { RouteMapViewParsed } from "@yishu/shared";
describe("offline map document", () => {
  it.each([
    [undefined, 13, 10],
    [{ baseUrl: "https://8.136.121.71/maps/national-20261003-v2" }, 15, 12],
  ] as const)(
    "limits route auto-fit to three zoom-out steps, without restricting manual zoom",
    (options, maxZoom, fitZoom) => {
      const html = buildLocalMapHtml(options);
      expect(html).toContain(`var routeFitMaxZoom=${fitZoom};`);
      expect(html).toContain(`minZoom:2,maxZoom:${maxZoom},zoomControl:false`);
      const start = html.indexOf("window.yishuMapFit=function()");
      const end = html.indexOf("window.yishuUpdateMap=", start);
      const fit = new Function(
        "map",
        "points",
        "L",
        "inset",
        "window",
        "routeFitMaxZoom",
        html.slice(start, end)
      );
      const map = { invalidateSize: vi.fn(), fitBounds: vi.fn() };
      const L = { latLngBounds: vi.fn((points) => points) };
      const window = { yishuMapOverview: vi.fn(), yishuMapFit: () => {} };
      for (const points of [
        [[31.23, 121.47]],
        [
          [31.23, 121.47],
          [31.2301, 121.4701],
        ],
        [
          [31.23, 121.47],
          [39.91, 116.4],
        ],
      ]) {
        fit(map, points, L, 64, window, fitZoom);
        window.yishuMapFit();
        expect(map.fitBounds).toHaveBeenLastCalledWith(points, {
          paddingTopLeft: [72, 108],
          paddingBottomRight: [80, 70],
          maxZoom: fitZoom,
          animate: false,
        });
      }
      fit(map, [], L, 64, window, fitZoom);
      window.yishuMapFit();
      expect(window.yishuMapOverview).toHaveBeenCalledOnce();
      expect(map.fitBounds).toHaveBeenCalledTimes(3);
      expect(html).toContain("if(first){window.yishuMapFit();first=false}");
    }
  );
  it("bundles Leaflet and static geometry, with no online SDK or tiles", () => {
    const html = buildLocalMapHtml();
    expect(html).toContain("Leaflet 1.9.4");
    expect(html).toContain("crs:L.CRS.EPSG3857");
    expect(html).toContain("var base=L.geoJSON(");
    expect(html).toContain("style:{stroke:false,fillColor:'#fafcfd',fillOpacity:1}");
    expect(html).not.toContain("province-borders");
    expect(html).not.toContain("L.svgOverlay(");
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain("api.map.baidu.com");
    expect(html).not.toContain("L.tileLayer(");
    expect(html).toContain("paddingTopLeft:[72,inset+44]");
    expect(html).toContain("if(first)");
    expect(html).toContain("touch-action:none;overscroll-behavior:none");
    expect(html).toContain("if(event.cancelable)event.preventDefault()");
    expect(html).toContain("{passive:false}");
    expect(html).toContain("window.yishuMapDetails=function");
    expect(html).toContain("payload.id!==requestId");
    expect(html).toContain("detail-request:");
    expect(html).toContain("city-boundaries");
    expect(html).toContain("district-boundaries");
    expect(html).toContain("physical-water");
    expect(html).toContain("payload.waters");
    expect(html).toContain("f.properties.source!=='OSM'");
    expect(html).toContain("OpenStreetMap contributors");
    expect(html).toContain("ODbL-1.0");
    expect(html).toContain("view.segments");
    expect(html).not.toContain("line(view.remainingPath");
    expect(html).toContain("occupied.some");
    expect(html).toContain("maxZoom:13");
    expect(html).toContain('id="map-license-notices"');
    expect(html).toContain("Permission is hereby granted");
    expect(html).not.toContain("310101");
  });
  it("escapes user labels and sends only the already-filtered DTO", () => {
    const view: RouteMapViewParsed = {
      status: "DISPATCHED",
      origin: {
        name: "</script><img>",
        province: "上海市",
        city: "上海市",
        district: "黄浦区",
        x: 1,
        y: 2,
      },
      destination: null,
      completedPath: [],
      remainingPath: [],
      lastKnownPosition: null,
      approximatePosition: null,
      facts: [],
    };
    const script = mapUpdateScript(view, 82);
    expect(script).not.toContain("</script>");
    expect(script).toContain("\\u003c");
    expect(script).toContain('"destination":null');
    expect(script).toContain(",82)");
  });
});

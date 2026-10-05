import { describe, expect, it } from "vitest";
import { buildLocalMapHtml, mapUpdateScript } from "./localMapHtml";
import type { RouteMapViewParsed } from "@yishu/shared";
describe("offline map document", () => {
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

import { describe, expect, it } from "vitest";
import type { RouteMapViewParsed } from "@yishu/shared";
import { buildBaiduMapHtml, toApproximateLngLat } from "./baiduMapHtml";
import { MAP_COLORS } from "./theme";

const view: RouteMapViewParsed = {
  status: "IN_TRANSIT",
  origin: { x: 800, y: 200, name: "起点", province: "省", city: "市" },
  destination: { x: 900, y: 250, name: "终点", province: "省", city: "市" },
  completedPath: [{ x: 800, y: 200 }],
  remainingPath: [
    { x: 800, y: 200 },
    { x: 900, y: 250 },
  ],
  lastKnownPosition: { x: 800, y: 200 },
  approximatePosition: { x: 850, y: 225 },
  facts: [],
};

describe("百度地图输入", () => {
  it("在线地图与离线地图使用相同的轨迹和标记配色", () => {
    const html = buildBaiduMapHtml(view, "test-key");
    expect(html).toContain(`line(remaining, '${MAP_COLORS.remaining}', 'dashed')`);
    expect(html).toContain(`line(completed, '${MAP_COLORS.completed}', 'solid')`);
    expect(html).toContain(`marker(destination, '${MAP_COLORS.destination}'`);
    expect(html).toContain(`marker(lastKnown, '${MAP_COLORS.lastKnown}'`);
    expect(html).toContain(`background:${MAP_COLORS.paper}`);
  });
  it("只把公开视图坐标反投影为近似经纬度", () => {
    expect(toApproximateLngLat({ x: 500, y: 400 })).toEqual([0, 0]);
    expect(toApproximateLngLat({ x: 800, y: 200 })).toEqual([108, 45]);
    const html = buildBaiduMapHtml(view, "a&b");
    expect(html).toContain("ak=a%26b");
    expect(html).toContain("BMap.Convertor");
    expect(html).toContain("convertor.translate(raw.slice(i, i + 10), 1, 5");
    expect(html).toContain('"remaining":[[108,45],[144,33.75]]');
  });

  it("收件人的已净化视图不会带入未来路线或目的地", () => {
    const recipientView: RouteMapViewParsed = {
      ...view,
      destination: null,
      remainingPath: [],
      approximatePosition: null,
    };
    const html = buildBaiduMapHtml(recipientView, "test-key");
    expect(html).toContain('"destination":null');
    expect(html).toContain('"remaining":[]');
    expect(html).toContain('"approximate":null');
    expect(html).not.toContain("终点");
    expect(html).not.toContain("144,33.75");
  });
});

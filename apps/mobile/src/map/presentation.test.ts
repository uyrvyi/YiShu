import { describe, expect, it } from "vitest";
import type { RouteMapViewParsed } from "@yishu/shared";
import {
  MAP_FOOTNOTE,
  MAP_DISPLAY_TIME_ZONE,
  STATUS_LABELS,
  factRowsFor,
  formatFactTime,
  positionNoteFor,
  routeLabelFor,
} from "./presentation";

/**
 * 地图展示层（Phase 8 Gate M3）：事实时间固定 `Asia/Shanghai`，不随设备时区变化；
 * 展示文案不含 ETA / 倒计时 / 预计送达。
 */
describe("map presentation（Asia/Shanghai）", () => {
  const ISO = "2026-09-13T00:00:00.000Z";

  it("同一时刻在不同设备时区下显示完全一致（固定 Asia/Shanghai）", () => {
    const original = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Asia/Shanghai"]) {
        process.env.TZ = tz;
        expect(formatFactTime(ISO), tz).toBe("2026-09-13 08:00");
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("午夜与跨日按上海时区（不出现 24:xx，也不随设备回退一天）", () => {
    expect(formatFactTime("2026-09-12T16:00:00.000Z")).toBe("2026-09-13 00:00");
    expect(formatFactTime("2026-09-12T15:59:00.000Z")).toBe("2026-09-12 23:59");
  });

  it("时区常量为 Asia/Shanghai（规范 §70，禁止设备本地时区）", () => {
    expect(MAP_DISPLAY_TIME_ZONE).toBe("Asia/Shanghai");
    // Intl 实参固定，不传 undefined（否则回退设备时区）
    expect(formatFactTime(ISO)).toBe("2026-09-13 08:00");
  });

  function viewWith(overrides: Partial<RouteMapViewParsed> = {}): RouteMapViewParsed {
    return {
      status: "IN_TRANSIT",
      origin: { name: "北京", province: "北京市", city: "北京市", x: 1, y: 2 },
      destination: { name: "上海", province: "上海市", city: "上海市", x: 3, y: 4 },
      completedPath: [{ x: 1, y: 2 }],
      remainingPath: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      approximatePosition: { x: 2, y: 3 },
      lastKnownPosition: { x: 1, y: 2 },
      facts: [],
      ...overrides,
    };
  }

  it("位置说明只表达大概位置 / 最后确报，不含 ETA / 剩余时间", () => {
    const moving = positionNoteFor(viewWith());
    const stopped = positionNoteFor(viewWith({ approximatePosition: null }));
    const none = positionNoteFor(viewWith({ approximatePosition: null, lastKnownPosition: null }));
    expect(moving).toContain("大概位置");
    expect(stopped).toContain("最后确报");
    expect(none).toBeNull();

    for (const text of [
      moving,
      stopped,
      routeLabelFor(viewWith()),
      ...Object.values(STATUS_LABELS),
    ]) {
      if (text === null) continue;
      for (const banned of ["ETA", "eta", "倒计时", "剩余", "预计送达", "最快", "多久"]) {
        expect(text.includes(banned), `文案含 "${banned}": ${text}`).toBe(false);
      }
    }
    // 底部说明明确「不提供预计送达时间」（允许出现该词，但必须是显式否认）
    expect(MAP_FOOTNOTE).toContain("不提供预计送达时间");
  });

  it("未启程时路线标题为占位文案，不显示半截路线", () => {
    expect(routeLabelFor(viewWith({ origin: null }))).toBe("尚未启程");
    expect(routeLabelFor(viewWith({ destination: null }))).toBe("尚未启程");
    expect(routeLabelFor(viewWith())).toBe("北京 → 上海");
  });

  it("事实行最新在前、时间用上海时区、仅含只读文本字段", () => {
    const view = viewWith({
      facts: [
        {
          type: "DISPATCHED",
          title: "已寄出",
          description: "信件已寄出",
          location: { province: "北京市", city: "北京市" },
          happenedAt: "2026-09-12T16:00:00.000Z",
          x: 1,
          y: 2,
        },
        {
          type: "ARRIVED_STATION",
          title: "到达驿站",
          description: "到达临沂驿站",
          location: { province: "山东省", city: "临沂市" },
          happenedAt: "2026-09-13T00:00:00.000Z",
          x: 3,
          y: 4,
        },
      ],
    });
    const rows = factRowsFor(view);
    expect(rows.length).toBe(2);
    expect(rows[0]?.title).toBe("到达驿站");
    expect(rows[0]?.meta).toContain("2026-09-13 08:00");
    expect(rows[1]?.meta).toContain("2026-09-13 00:00");
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["description", "key", "meta", "title"]);
  });
});

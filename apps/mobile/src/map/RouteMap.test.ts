import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { MAP_FACT_LIMIT, MAP_FIT, type RouteMapViewParsed } from "@yishu/shared";

/**
 * RouteMap / 图层 / 事实列表的**真实渲染树**覆盖（Phase 8 Gate M4）。
 *
 * 说明：本仓库 Mobile 测试运行在 node 环境、不引入重型 RN 测试渲染器；这里直接调用
 * 组件函数并遍历其返回的 React element tree（react-test-renderer 内部同样只是调用组件 +
 * 遍历 element），因此断言的是**组件真实消费的 props / 结构**，不只是几何 helper。
 * `react-native` / `react-native-svg` 以最小 host 组件替身注入（不加载原生模块）。
 */
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown): unknown => styles },
  View: "View",
  Text: "Text",
  ScrollView: "ScrollView",
}));

vi.mock("react-native-svg", () => ({
  default: "Svg",
  Svg: "Svg",
  Circle: "Circle",
  G: "G",
  Path: "Path",
  Polyline: "Polyline",
  Rect: "Rect",
}));

import { RouteMap } from "./RouteMap";
import { FactList } from "./FactList";
import {
  ApproximatePositionLayer,
  ChinaOutlineLayer,
  CompletedRouteLayer,
  FactNodeLayer,
  LastKnownPositionLayer,
  ProvinceBoundaryLayer,
  RemainingRouteLayer,
} from "./layers";
import { MAP_STROKE, REMAINING_DASH } from "./theme";
import { formatFactTime } from "./presentation";

interface AnyElement {
  type: unknown;
  props: Record<string, unknown> & { children?: ReactNode };
}

function collectElements(node: ReactNode, out: AnyElement[] = []): AnyElement[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (typeof node !== "object") return out;
  const element = node as AnyElement;
  out.push(element);
  collectElements(element.props.children, out);
  return out;
}

function typeName(type: unknown): string {
  if (typeof type === "string") return type;
  if (typeof type === "function") return (type as { name?: string }).name ?? "anonymous";
  return "unknown";
}

function names(elements: readonly AnyElement[]): string[] {
  return elements.map((element) => typeName(element.type));
}

/** 只读渲染结果里的可交互组件（事实列表必须完全没有）。 */
const INTERACTIVE_TYPES = [
  "Pressable",
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableWithoutFeedback",
  "Button",
  "Link",
  "TextInput",
];

function factOf(index: number) {
  return {
    type: "ARRIVED_STATION" as const,
    title: `事实 ${String(index)}`,
    description: `描述 ${String(index)}`,
    location: { province: "山东省", city: "临沂市" },
    happenedAt: new Date(Date.UTC(2026, 8, 13, index, 0, 0)).toISOString(),
    x: 100 + index,
    y: 200 + index,
  };
}

function viewWith(overrides: Partial<RouteMapViewParsed> = {}): RouteMapViewParsed {
  return {
    status: "IN_TRANSIT",
    origin: { name: "北京", province: "北京市", city: "北京市", x: 300, y: 200 },
    destination: { name: "上海", province: "上海市", city: "上海市", x: 500, y: 400 },
    completedPath: [{ x: 300, y: 200 }],
    remainingPath: [
      { x: 300, y: 200 },
      { x: 400, y: 300 },
      { x: 500, y: 400 },
    ],
    approximatePosition: { x: 350, y: 250 },
    lastKnownPosition: { x: 300, y: 200 },
    facts: [factOf(1), factOf(2)],
    ...overrides,
  };
}

describe("RouteMap 渲染树（Phase 8 M4）", () => {
  it("渲染 §17 七个图层，且不存在任何 DropArea / 掉落范围图层", () => {
    const tree = collectElements(RouteMap({ view: viewWith() }));
    const layerNames = names(tree);

    for (const layer of [
      "ChinaOutlineLayer",
      "ProvinceBoundaryLayer",
      "RemainingRouteLayer",
      "CompletedRouteLayer",
      "ApproximatePositionLayer",
      "LastKnownPositionLayer",
      "FactNodeLayer",
    ]) {
      expect(layerNames, `缺少图层 ${layer}`).toContain(layer);
    }
    expect(layerNames.filter((name) => /drop/i.test(name))).toEqual([]);
    // 起点 / 终点标记（§18 视觉规则）
    const ids = tree.map((element) => element.props.id).filter((id) => typeof id === "string");
    expect(ids).toContain("origin-marker");
    expect(ids).toContain("destination-marker");
  });

  it("已走路线实线 / 未走路线虚线（strokeDasharray 只在 remaining 上）", () => {
    const view = viewWith({
      completedPath: [
        { x: 300, y: 200 },
        { x: 400, y: 300 },
      ],
    });
    const completed = collectElements(CompletedRouteLayer({ points: view.completedPath }));
    const remaining = collectElements(RemainingRouteLayer({ points: view.remainingPath }));
    expect(completed.length).toBe(1);
    expect(remaining.length).toBe(1);
    expect(completed[0]?.props.strokeDasharray).toBeUndefined();
    expect(remaining[0]?.props.strokeDasharray).toBe(REMAINING_DASH);
    expect(remaining[0]?.props.stroke).not.toBe(completed[0]?.props.stroke);
    // 单点路径不渲染（避免无意义的 1 点折线）
    expect(CompletedRouteLayer({ points: [{ x: 1, y: 1 }] })).toBeNull();
    expect(RemainingRouteLayer({ points: [] })).toBeNull();
  });

  it("L1 · 缩放组内的底图描边宽度经补偿后 = theme 声明宽度", () => {
    const outline = collectElements(ChinaOutlineLayer()).filter(
      (element) => element.type === "Path"
    )[0];
    const province = collectElements(ProvinceBoundaryLayer()).filter(
      (element) => element.type === "Path"
    )[0];
    if (outline === undefined || province === undefined) throw new Error("layer missing");
    expect(Number(outline.props.strokeWidth) * MAP_FIT.scale).toBeCloseTo(MAP_STROKE.outline, 6);
    expect(Number(province.props.strokeWidth) * MAP_FIT.scale).toBeCloseTo(MAP_STROKE.province, 6);
    // ADM1 边界渲染 34 个行政单元（数据完整性 / 拓扑由 geometry.test.ts 与 boundary.test.ts 覆盖）
    const provincePaths = collectElements(ProvinceBoundaryLayer()).filter(
      (element) => element.type === "Path"
    );
    expect(provincePaths.length).toBe(34);
  });

  it("大概位置：光晕 + 标记两层圆；null（失联 / 终态）时不渲染", () => {
    const position = { x: 350, y: 250 };
    const tree = collectElements(ApproximatePositionLayer({ position }));
    const circles = tree.filter((element) => element.type === "Circle");
    expect(circles.length).toBe(2);
    expect(circles.some((circle) => typeof circle.props.fillOpacity === "number")).toBe(true);
    expect(ApproximatePositionLayer({ position: null })).toBeNull();
    expect(LastKnownPositionLayer({ position: null })).toBeNull();
  });

  it("事实节点图层按 DTO 渲染（≤ MAP_FACT_LIMIT），空集合不渲染节点", () => {
    const capped = Array.from({ length: MAP_FACT_LIMIT }, (_, index) => factOf(index));
    const circles = (facts: readonly ReturnType<typeof factOf>[]) =>
      collectElements(FactNodeLayer({ facts })).filter((element) => element.type === "Circle")
        .length;
    expect(circles(capped)).toBe(MAP_FACT_LIMIT);
    expect(circles([])).toBe(0);
    expect(circles([factOf(1)])).toBe(1);
  });

  it("失联 / 终态：RouteMap 传入 null 位置（只保留最后确报）", () => {
    for (const status of ["COURIER_MISSING", "PERMANENTLY_LOST", "DESTROYED"] as const) {
      const tree = collectElements(
        RouteMap({ view: viewWith({ status, approximatePosition: null, remainingPath: [] }) })
      );
      const approx = tree.find((element) => typeName(element.type) === "ApproximatePositionLayer");
      const lastKnown = tree.find((element) => typeName(element.type) === "LastKnownPositionLayer");
      if (approx === undefined || lastKnown === undefined) throw new Error("layer missing");
      expect(approx.props.position, status).toBeNull();
      expect(lastKnown.props.position, status).toEqual({ x: 300, y: 200 });
    }
  });

  it("PIGEON 零 Leg / 未启程：无剩余路线 → 不渲染虚线层", () => {
    const tree = collectElements(
      RouteMap({
        view: viewWith({
          origin: null,
          destination: null,
          completedPath: [],
          remainingPath: [],
          approximatePosition: null,
          lastKnownPosition: null,
          facts: [],
        }),
      })
    );
    const remaining = tree.find((element) => typeName(element.type) === "RemainingRouteLayer");
    if (remaining === undefined) throw new Error("remaining layer missing");
    expect(remaining.props.points).toEqual([]);
    expect(RemainingRouteLayer({ points: [] })).toBeNull();
  });
});

describe("FactList 只读事实列表（Phase 8 M4）", () => {
  it("渲染每一条事实，且不含任何可交互组件（只读详情）", () => {
    const tree = collectElements(FactList({ view: viewWith() }));
    const textNodes = tree.filter((element) => element.type === "Text");
    expect(textNodes.length).toBeGreaterThan(0);
    for (const element of tree) {
      expect(INTERACTIVE_TYPES, `事实列表出现可交互组件 ${typeName(element.type)}`).not.toContain(
        typeName(element.type)
      );
    }
    const rendered = textNodes.map((element) => String(element.props.children ?? ""));
    // 事实时间使用固定 Asia/Shanghai 展示（含 08:00 上海时刻）
    expect(rendered.some((text) => text.includes(formatFactTime(factOf(1).happenedAt)))).toBe(true);
  });

  it("无事实时显示占位文案（不渲染空行）", () => {
    const tree = collectElements(FactList({ view: viewWith({ facts: [] }) }));
    const rendered = tree
      .filter((element) => element.type === "Text")
      .map((element) => String(element.props.children ?? ""));
    expect(rendered).toContain("暂无可确认事实");
  });
});

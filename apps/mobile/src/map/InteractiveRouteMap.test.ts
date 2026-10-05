import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import type { RouteMapViewParsed } from "@yishu/shared";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  state: new Map<number, unknown>(),
  refCursor: 0,
  refs: new Map<number, { current: unknown }>(),
  effectCursor: 0,
  effects: new Map<number, { deps: readonly unknown[]; cleanup?: () => void }>(),
  appStateListeners: new Set<(state: string) => void>(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    return [
      hooks.state.has(index) ? hooks.state.get(index) : initial,
      (next: unknown) => {
        const current = hooks.state.has(index) ? hooks.state.get(index) : initial;
        hooks.state.set(index, typeof next === "function" ? next(current) : next);
      },
    ];
  },
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => {
    const index = hooks.refCursor++;
    if (!hooks.refs.has(index)) hooks.refs.set(index, { current });
    return hooks.refs.get(index);
  },
  useEffect: (effect: () => (() => void) | undefined, deps: readonly unknown[]) => {
    const index = hooks.effectCursor++;
    const previous = hooks.effects.get(index);
    if (
      previous &&
      deps.length === previous.deps.length &&
      deps.every((v, i) => Object.is(v, previous.deps[i]))
    )
      return;
    previous?.cleanup?.();
    hooks.effects.set(index, { deps, cleanup: effect() });
  },
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (s: unknown) => s },
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      hooks.appStateListeners.add(listener);
      return { remove: () => hooks.appStateListeners.delete(listener) };
    },
  },
}));
vi.mock("react-native-webview", () => ({ default: "WebView" }));
vi.mock("lucide-react-native", () => ({
  Earth: "Earth",
  RefreshCw: "RefreshCw",
  ScanLine: "ScanLine",
}));
vi.mock("./RouteMap", () => ({ RouteMap: "RouteMap" }));
type Element = { type: unknown; props: Record<string, unknown> & { children?: ReactNode } };
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...nodes(element.props.children)];
}
const view: RouteMapViewParsed = {
  status: "IN_TRANSIT",
  origin: null,
  destination: null,
  completedPath: [],
  remainingPath: [],
  lastKnownPosition: null,
  approximatePosition: null,
  facts: [],
};
async function render(data = view, onInteractionChange?: (active: boolean) => void) {
  const { InteractiveRouteMap } = await import("./InteractiveRouteMap");
  const run = () => {
    hooks.cursor = 0;
    hooks.refCursor = 0;
    hooks.effectCursor = 0;
    return nodes(InteractiveRouteMap({ view: data, onInteractionChange }));
  };
  let tree = run();
  const layout = tree.find((n) => n.props.accessibilityLabel === "可缩放的信件运输地图")?.props
    .onLayout as ((e: unknown) => void) | undefined;
  if (layout && !tree.some((n) => n.type === "WebView")) {
    layout({ nativeEvent: { layout: { width: 390, height: 312 } } });
    tree = run();
  }
  return tree;
}
function text(tree: Element[]) {
  return tree.filter((e) => e.type === "Text").map((e) => e.props.children);
}
function message(tree: Element[], data: string) {
  (tree.find((e) => e.type === "WebView")?.props.onMessage as (e: unknown) => void)({
    nativeEvent: { data },
  });
}
beforeEach(() => {
  hooks.state.clear();
  hooks.refs.clear();
  hooks.effects.clear();
  hooks.appStateListeners.clear();
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => {
  hooks.effects.forEach(({ cleanup }) => cleanup?.());
  vi.useRealTimers();
});
describe("bundled interactive transport map", () => {
  it("loads public background detail through the native bridge without replacing the document", async () => {
    const tree = await render();
    const injectJavaScript = vi.fn();
    hooks.refs.get(0)!.current = { injectJavaScript };
    message(tree, 'detail-request:{"id":1,"zoom":10,"bounds":[121.4,31.1,121.7,31.4]}');
    expect(injectJavaScript).toHaveBeenCalledOnce();
    expect(injectJavaScript.mock.calls[0]![0]).toContain("window.yishuMapDetails(");
    expect(injectJavaScript.mock.calls[0]![0]).toContain("黄浦区");
    expect(injectJavaScript.mock.calls[0]![0]).not.toContain("remainingPath");
    message(tree, "detail-request:bad");
    expect(injectJavaScript).toHaveBeenCalledOnce();
  });
  it("locks before moving without claiming responder ownership and releases only the last finger", async () => {
    const changed = vi.fn();
    const tree = await render(view, changed);
    const container = tree.find(
      (node) => node.props.accessibilityLabel === "可缩放的信件运输地图"
    )!;
    expect((container.props.onStartShouldSetResponderCapture as () => boolean)()).toBe(false);
    (container.props.onTouchStart as () => void)();
    (container.props.onTouchMove as () => void)();
    expect(changed.mock.calls).toEqual([[true]]);
    const end = container.props.onTouchEnd as (event: unknown) => void;
    end({ nativeEvent: { touches: [{}] } });
    expect(changed.mock.calls).toEqual([[true]]);
    end({ nativeEvent: { touches: [] } });
    end({ nativeEvent: { touches: [] } });
    expect(changed.mock.calls).toEqual([[true], [false]]);
    expect(tree.find((node) => node.type === "WebView")?.props.nestedScrollEnabled).toBe(true);
  });
  it("unlocks on touch cancellation and backgrounding", async () => {
    const changed = vi.fn();
    const tree = await render(view, changed);
    const props = tree.find(
      (node) => node.props.accessibilityLabel === "可缩放的信件运输地图"
    )!.props;
    (props.onTouchStart as () => void)();
    (props.onTouchCancel as (event: unknown) => void)({ nativeEvent: { touches: [] } });
    (props.onTouchStart as () => void)();
    hooks.appStateListeners.forEach((listener) => listener("background"));
    expect(changed.mock.calls).toEqual([[true], [false], [true], [false]]);
  });
  it("unlocks when rendering fails or the map unmounts", async () => {
    const changed = vi.fn();
    const tree = await render(view, changed);
    (tree.find((node) => node.props.onTouchStart)?.props.onTouchStart as () => void)();
    message(tree, "error:render");
    await render(view, changed);
    expect(changed.mock.calls).toEqual([[true], [false]]);
    const retry = (await render(view, changed)).find(
      (node) => node.props.accessibilityLabel === "重新绘制运输地图"
    )!;
    (retry.props.onPress as () => void)();
    const next = await render(view, changed);
    (next.find((node) => node.props.onTouchStart)?.props.onTouchStart as () => void)();
    hooks.effects.forEach(({ cleanup }) => cleanup?.());
    expect(changed.mock.calls).toEqual([[true], [false], [true], [false]]);
  });
  it("renders without AK and ends loading when overlays are ready", async () => {
    const tree = await render();
    expect(text(tree)).toContain("地图绘制中");
    message(tree, "ready");
    expect(text(await render())).not.toContain("地图绘制中");
  });
  it("measures and sizes both native wrappers", async () => {
    const tree = await render();
    const web = tree.find((n) => n.type === "WebView");
    expect(web?.props.containerStyle).toContainEqual({ width: 390, height: 312 });
    expect(web?.props.style).toContainEqual({ width: 390, height: 312 });
  });
  it("injects updates without replacing HTML or resetting gestures", async () => {
    const tree = await render();
    const injectJavaScript = vi.fn();
    hooks.refs.get(0)!.current = { injectJavaScript };
    message(tree, "document-ready");
    expect(injectJavaScript).toHaveBeenCalled();
    const next = await render({ ...view, status: "OUT_FOR_DELIVERY" });
    expect(next.find((n) => n.type === "WebView")?.props.source).toEqual(
      tree.find((n) => n.type === "WebView")?.props.source
    );
    expect(injectJavaScript.mock.lastCall?.[0]).toContain("OUT_FOR_DELIVERY");
  });
  it("reports render failures with a working retry", async () => {
    message(await render(), "error:render");
    const tree = await render();
    expect(text(tree)).toContain("地图绘制失败");
    const retry = tree.find((n) => n.props.accessibilityLabel === "重新绘制运输地图");
    (retry?.props.onPress as () => void)();
    expect(text(await render())).toContain("地图绘制中");
  });
  it("keeps the national overview and visible route fit as separate camera actions", async () => {
    const tree = await render();
    const injectJavaScript = vi.fn();
    hooks.refs.get(0)!.current = { injectJavaScript };
    const overview = tree.find((node) => node.props.accessibilityLabel === "查看全国底图");
    (overview?.props.onPress as () => void)();
    expect(injectJavaScript).toHaveBeenLastCalledWith("window.yishuMapOverview();true;");
    const fit = tree.find((node) => node.props.accessibilityLabel === "显示完整可见路线");
    (fit?.props.onPress as () => void)();
    expect(injectJavaScript).toHaveBeenLastCalledWith("window.yishuMapFit();true;");
  });
  it("times out stalled rendering and blocks external navigation", async () => {
    const tree = await render();
    const allow = tree.find((n) => n.type === "WebView")?.props
      .onShouldStartLoadWithRequest as (r: { url: string }) => boolean;
    expect(allow({ url: "https://api.map.baidu.com/" })).toBe(false);
    expect(allow({ url: "about:blank" })).toBe(true);
    vi.advanceTimersByTime(10000);
    expect(text(await render())).toContain("地图绘制超时");
  });
  it("enables the tile background only with an explicitly configured endpoint", async () => {
    vi.stubEnv("EXPO_PUBLIC_MAP_TILE_BASE_URL", "https://example.com/maps/national-v2");
    try {
      const tree = await render();
      const source = tree.find((n) => n.type === "WebView")?.props.source as { html: string };
      expect(source.html).toContain("connect-src https://example.com");
      expect(source.html).toContain("staticTileBase=");
      expect(source.html).toContain("credentials:'omit'");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("falls back to the bundled map if tile configuration is invalid", async () => {
    vi.stubEnv("EXPO_PUBLIC_MAP_TILE_BASE_URL", "http://8.136.121.71/maps/v2");
    try {
      const tree = await render();
      const source = tree.find((n) => n.type === "WebView")?.props.source as { html: string };
      expect(source.html).toContain("connect-src 'none'");
      expect(source.html).not.toContain("staticTileBase=");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

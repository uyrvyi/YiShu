import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  cleanup: [] as Array<() => void>,
  pan: {} as Record<string, (...args: any[]) => any>,
  Value: class {
    value: number;
    constructor(value: number) {
      this.value = value;
    }
    setValue = vi.fn((value: number) => {
      this.value = value;
    });
    stopAnimation = vi.fn();
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = next;
      },
    ];
  },
  useRef(current: unknown) {
    const index = hooks.cursor++;
    return (hooks.slots[index] ??= { current });
  },
  useMemo(factory: () => unknown) {
    const index = hooks.cursor++;
    return (hooks.slots[index] ??= factory());
  },
  useEffect(factory: () => () => void) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) {
      hooks.slots[index] = true;
      hooks.cleanup.push(factory());
    }
  },
}));
vi.mock("react-native", () => ({
  View: "View",
  Modal: "Modal",
  Text: "Text",
  StyleSheet: { create: (styles: unknown) => styles },
  Animated: {
    View: "AnimatedView",
    Value: hooks.Value,
    timing: () => ({ start: vi.fn() }),
  },
  PanResponder: {
    create: (config: typeof hooks.pan) => {
      hooks.pan = config;
      return { panHandlers: config };
    },
  },
}));
import { ImagePreview, type PreviewGallery } from "./ImagePreview";

// Run the installed RN memoization algorithm; static transforms are not native graph keys.
const require = createRequire(import.meta.url);
const nativeRequire = createRequire(realpathSync(require.resolve("react-native/package.json")));
const memoFile = join(
  dirname(nativeRequire.resolve("react-native/package.json")),
  "src/private/animated/createAnimatedPropsMemoHook.js"
);
const { code } = nativeRequire("@babel/core").transformSync(readFileSync(memoFile, "utf8"), {
  filename: memoFile,
  configFile: false,
  babelrc: false,
  presets: [nativeRequire.resolve("@react-native/babel-preset")],
});
const nativeMemoModule = { exports: {} as any };
new Function("require", "module", "exports", code)(
  (name: string) => {
    if (name.endsWith("/AnimatedNode")) return { __esModule: true, default: hooks.Value };
    if (name.endsWith("/AnimatedEvent")) return { AnimatedEvent: class {} };
    if (name.endsWith("/AnimatedObject"))
      return {
        isPlainObject: (value: unknown) => Object.getPrototypeOf(value) === Object.prototype,
      };
    if (name.endsWith("/flattenStyle"))
      return {
        __esModule: true,
        default: (style: unknown) => (Array.isArray(style) ? Object.assign({}, ...style) : style),
      };
    return nativeRequire(name);
  },
  nativeMemoModule,
  nativeMemoModule.exports
);
const { createCompositeKeyForProps, areCompositeKeysEqual } = nativeMemoModule.exports;

function renderedTransform(tree: any[]) {
  return tree.find((node) => node.type === "AnimatedView").props.style[1].transform;
}
function nativePixels(transform: Array<Record<string, number | InstanceType<typeof hooks.Value>>>) {
  const result = { zoom: 1, x: 0, y: 0 };
  for (const entry of transform) {
    for (const [property, input] of Object.entries(entry)) {
      const value = input instanceof hooks.Value ? input.value : input;
      if (property === "translateX") result.x += value;
      if (property === "translateY") result.y += value;
      if (property === "scale") result.zoom = value;
    }
  }
  return result;
}

function children(node: ReactNode): any[] {
  if (Array.isArray(node)) return node.flatMap(children);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node, ...children(node.props.children)];
}
function render(close: () => void, aspectRatio = 0.5, gallery?: PreviewGallery) {
  hooks.cursor = 0;
  return children(ImagePreview({ children: "image", aspectRatio, onClose: close, gallery }));
}
function touches(distance: number, x = 200, y = 400) {
  return {
    nativeEvent: {
      touches: distance
        ? [
            { pageX: x - distance / 2, pageY: y },
            { pageX: x + distance / 2, pageY: y },
          ]
        : [{ pageX: x, pageY: y }],
    },
  };
}
function unmount() {
  hooks.cleanup.forEach((cleanup) => cleanup());
  hooks.cleanup = [];
  hooks.slots = [];
}
beforeEach(() => {
  vi.useFakeTimers();
  hooks.slots = [];
  hooks.cleanup = [];
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

describe("letter gallery gestures", () => {
  function setup(index = 1, count = 3) {
    const close = vi.fn();
    const onChange = vi.fn();
    const tree = render(close, 0.5, { index, count, onChange });
    const viewport = tree.find((node) => node.props.testID === "image-preview-viewport");
    viewport.props.onLayout({ nativeEvent: { layout: { width: 400, height: 800 } } });
    function swipe(dx: number, dy = 0, distance = 0) {
      viewport.props.onTouchStart(touches(distance));
      hooks.pan.onPanResponderGrant(touches(distance));
      hooks.pan.onPanResponderMove(touches(distance, 200 + dx, 400 + dy));
      viewport.props.onTouchEnd({ nativeEvent: { touches: [] } });
      hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
      vi.advanceTimersByTime(1000);
    }
    return { close, onChange, tree, viewport, swipe };
  }
  it.each([
    [-130, 2],
    [130, 0],
  ])("swipes from the selected image (dx=%s)", (dx, next) => {
    const { swipe, close, onChange } = setup();
    swipe(dx);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(next);
    expect(close).not.toHaveBeenCalled();
    expect(hooks.slots[0]).toEqual({ zoom: 1, x: 0, y: 0 });
  });
  it("supports successive swipes without recreating the modal or stale page callbacks", () => {
    const { swipe, close, onChange } = setup(0, 4);
    swipe(-130);
    swipe(-130);
    swipe(130);
    expect(onChange.mock.calls).toEqual([[1], [2], [1]]);
    expect(close).not.toHaveBeenCalled();
  });
  it.each([
    [0, 3, 130],
    [2, 3, -130],
    [0, 1, -130],
    [0, 1, 130],
  ])("does not dismiss or wrap at a gallery edge (index=%s,count=%s,dx=%s)", (index, count, dx) => {
    const { swipe, close, onChange } = setup(index, count);
    swipe(dx);
    expect(onChange).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
  it("returns short horizontal and vertical drags without dismissing", () => {
    const { swipe, close, onChange } = setup();
    swipe(-40);
    swipe(0, -40);
    expect(onChange).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
  it.each([-200, 200])("still dismisses a vertical single-finger drag (dy=%s)", (dy) => {
    const { swipe, close, onChange } = setup();
    swipe(20, dy);
    expect(close).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("never switches or dismisses for two-finger translation", () => {
    const { swipe, close, onChange } = setup();
    swipe(-180, 200, 100);
    expect(onChange).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
  it("pans a zoomed image without switching and resets zoom on accessible page change", () => {
    const { viewport, swipe, close, onChange } = setup();
    viewport.props.onTouchStart(touches(100));
    hooks.pan.onPanResponderGrant(touches(100));
    hooks.pan.onPanResponderMove(touches(300));
    viewport.props.onTouchEnd({ nativeEvent: { touches: [] } });
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    swipe(-180);
    expect(hooks.slots[0]).toEqual({ zoom: 3, x: -180, y: 0 });
    expect(onChange).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    viewport.props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(2);
    expect(hooks.slots[0]).toEqual({ zoom: 1, x: 0, y: 0 });
  });
  it("retains tap-to-dismiss while displaying the current page count", () => {
    const { viewport, tree, close, onChange } = setup();
    expect(tree.find((node) => node.type === "Text").props.children).toEqual([2, " / ", 3]);
    viewport.props.onTouchStart(touches(0));
    hooks.pan.onPanResponderGrant(touches(0));
    viewport.props.onTouchEnd({ nativeEvent: { touches: [] } });
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    vi.advanceTimersByTime(350);
    expect(close).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("preview lifecycle with persistent hook state", () => {
  it.each([false, true])(
    "does not close when pinch loses and regains the responder (terminated=%s)",
    (terminated) => {
      const close = vi.fn();
      const viewport = render(close).find((node) => node.type === "View");
      viewport.props.onLayout({ nativeEvent: { layout: { width: 400, height: 800 } } });
      viewport.props.onTouchStart?.(touches(100));
      hooks.pan.onPanResponderGrant(touches(100));
      hooks.pan.onPanResponderMove(touches(200));
      viewport.props.onTouchEnd?.(touches(0));
      if (terminated) hooks.pan.onPanResponderTerminate(touches(0));
      hooks.pan.onPanResponderGrant(touches(0));
      viewport.props.onTouchEnd?.({ nativeEvent: { touches: [] } });
      hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
      vi.advanceTimersByTime(1000);
      expect(close).not.toHaveBeenCalled();
      expect(hooks.slots[0]).toEqual({ zoom: 2, x: 0, y: 0 });
      viewport.props.onTouchStart?.(touches(0));
      hooks.pan.onPanResponderGrant(touches(0));
      viewport.props.onTouchEnd?.({ nativeEvent: { touches: [] } });
      hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
      vi.advanceTimersByTime(350);
      expect(close).toHaveBeenCalledOnce();
    }
  );
  it("cancels a pending tap as soon as the second physical touch arrives, before grant", () => {
    const close = vi.fn();
    const viewport = render(close).find((node) => node.type === "View");
    viewport.props.onTouchStart?.(touches(0));
    hooks.pan.onPanResponderGrant(touches(0));
    viewport.props.onTouchEnd?.({ nativeEvent: { touches: [] } });
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    vi.advanceTimersByTime(300);
    viewport.props.onTouchStart?.(touches(100));
    vi.advanceTimersByTime(100);
    expect(close).not.toHaveBeenCalled();
    hooks.pan.onPanResponderGrant(touches(100));
    hooks.pan.onPanResponderMove(touches(200));
    viewport.props.onTouchEnd?.({ nativeEvent: { touches: [] } });
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    vi.advanceTimersByTime(1000);
    expect(close).not.toHaveBeenCalled();
  });
  it("keeps multi-touch protection when the second finger is observed only during capture", () => {
    const close = vi.fn();
    const viewport = render(close).find((node) => node.type === "View");
    viewport.props.onTouchStart?.(touches(0));
    hooks.pan.onPanResponderGrant(touches(0));
    hooks.pan.onStartShouldSetPanResponderCapture(touches(100));
    hooks.pan.onPanResponderEnd(touches(0));
    viewport.props.onTouchEnd?.({ nativeEvent: { touches: [] } });
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    vi.advanceTimersByTime(1000);
    expect(close).not.toHaveBeenCalled();
  });
  it("does not reset an active pinch when the initial modal show callback arrives late", () => {
    const close = vi.fn();
    const tree = render(close);
    const viewport = tree.find((node) => node.type === "View");
    viewport.props.onLayout({ nativeEvent: { layout: { width: 400, height: 800 } } });
    viewport.props.onTouchStart(touches(100));
    hooks.pan.onPanResponderGrant(touches(100));
    hooks.pan.onPanResponderMove(touches(200));
    tree.find((node) => node.type === "Modal").props.onShow();
    viewport.props.onTouchEnd(touches(0));
    hooks.pan.onPanResponderGrant(touches(0));
    viewport.props.onTouchEnd({ nativeEvent: { touches: [] } });
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    vi.advanceTimersByTime(1000);
    expect(close).not.toHaveBeenCalled();
    expect(hooks.slots[0]).toEqual({ zoom: 2, x: 0, y: 0 });
  });
  it("protects a release whose changedTouches reveal simultaneous finger lifts", () => {
    const close = vi.fn();
    const viewport = render(close).find((node) => node.type === "View");
    viewport.props.onTouchStart(touches(0));
    hooks.pan.onPanResponderGrant(touches(0));
    const end = {
      nativeEvent: { touches: [], changedTouches: touches(100).nativeEvent.touches },
    };
    viewport.props.onTouchEnd(end);
    hooks.pan.onPanResponderRelease(end);
    vi.advanceTimersByTime(1000);
    expect(close).not.toHaveBeenCalled();
  });
  it("cancelled touch sequences do not become taps, and the next genuine tap still closes", () => {
    const close = vi.fn();
    const viewport = render(close).find((node) => node.type === "View");
    viewport.props.onTouchStart(touches(100));
    hooks.pan.onPanResponderGrant(touches(100));
    viewport.props.onTouchCancel(touches(0));
    hooks.pan.onPanResponderGrant(touches(0));
    viewport.props.onTouchEnd({ nativeEvent: { touches: [] } });
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    vi.advanceTimersByTime(1000);
    expect(close).not.toHaveBeenCalled();
    hooks.pan.onStartShouldSetPanResponderCapture(touches(0));
    hooks.pan.onPanResponderGrant(touches(0));
    viewport.props.onTouchStart(touches(0));
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    viewport.props.onTouchEnd({ nativeEvent: { touches: [] } });
    vi.advanceTimersByTime(350);
    expect(close).toHaveBeenCalledOnce();
  });
  it("a genuine single tap still closes if its raw touch-end callback is missing", () => {
    const close = vi.fn();
    const viewport = render(close).find((node) => node.type === "View");
    viewport.props.onTouchStart(touches(0));
    hooks.pan.onPanResponderGrant(touches(0));
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    vi.advanceTimersByTime(350);
    expect(close).toHaveBeenCalledOnce();
  });
  it("a previously queued tap cannot close a later touch session", () => {
    const close = vi.fn();
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    try {
      const viewport = render(close).find((node) => node.type === "View");
      viewport.props.onTouchStart(touches(0));
      hooks.pan.onPanResponderGrant(touches(0));
      viewport.props.onTouchEnd({ nativeEvent: { touches: [] } });
      hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
      const staleTap = scheduled.mock.calls.at(-1)![0] as () => void;
      viewport.props.onTouchStart(touches(100));
      hooks.pan.onPanResponderGrant(touches(100));
      viewport.props.onTouchEnd({ nativeEvent: { touches: [] } });
      hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
      viewport.props.onTouchStart(touches(0));
      hooks.pan.onPanResponderGrant(touches(0));
      viewport.props.onTouchEnd({ nativeEvent: { touches: [] } });
      hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
      staleTap();
      expect(close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(350);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      scheduled.mockRestore();
    }
  });
  it("keeps native pixels aligned after pinch-pan release and subsequent two-finger pans", () => {
    const close = vi.fn();
    let tree = render(close);
    tree
      .find((node) => node.type === "View")
      .props.onLayout({ nativeEvent: { layout: { width: 400, height: 800 } } });
    let nativeTransform = renderedTransform(tree);
    let nativeKey = createCompositeKeyForProps({ style: { transform: nativeTransform } }, null);
    function commit() {
      tree = render(close);
      const transform = renderedTransform(tree);
      const key = createCompositeKeyForProps({ style: { transform } }, null);
      if (!areCompositeKeysEqual(nativeKey, key, null)) nativeTransform = transform;
      nativeKey = key;
      expect(nativePixels(nativeTransform)).toEqual(hooks.slots[0]);
    }
    hooks.pan.onPanResponderGrant(touches(100));
    hooks.pan.onPanResponderMove(touches(200, 250, 450));
    commit();
    expect(hooks.slots[0]).toEqual({ zoom: 2, x: 50, y: 50 });
    hooks.pan.onPanResponderEnd({ nativeEvent: { touches: [] } });
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    commit();
    for (let iteration = 0; iteration < 5; iteration++) {
      hooks.pan.onPanResponderGrant(touches(100));
      hooks.pan.onPanResponderMove(touches(100, 210, 410));
      hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
      commit();
      expect(hooks.slots[0]).toEqual({
        zoom: 2,
        x: 60 + iteration * 10,
        y: 60 + iteration * 10,
      });
    }
    hooks.pan.onPanResponderGrant(touches(100));
    hooks.pan.onPanResponderMove(touches(100, 700, -500));
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    commit();
    expect(hooks.slots[0]).toEqual({ zoom: 2, x: 200, y: -400 });
    hooks.pan.onPanResponderGrant(touches(100));
    hooks.pan.onPanResponderMove(touches(100, 150, 450));
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    commit();
    expect(hooks.slots[0]).toEqual({ zoom: 2, x: 150, y: -350 });
    expect(close).not.toHaveBeenCalled();
  });
  it("moves both axes at original scale and clears both offsets when a second finger joins", () => {
    const close = vi.fn();
    const tree = render(close);
    tree
      .find((node) => node.type === "View")
      .props.onLayout({ nativeEvent: { layout: { width: 400, height: 800 } } });
    const transform = tree.find((node) => node.type === "AnimatedView").props.style[1].transform;
    const x = transform[2].translateX;
    const y = transform[3].translateY;
    hooks.pan.onPanResponderGrant(touches(0));
    hooks.pan.onPanResponderMove(touches(0, 0, 300));
    expect(x.setValue).toHaveBeenLastCalledWith(-200);
    expect(y.setValue).toHaveBeenLastCalledWith(-100);
    hooks.pan.onPanResponderStart(touches(100));
    expect(x.setValue).toHaveBeenLastCalledWith(0);
    expect(y.setValue).toHaveBeenLastCalledWith(0);
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
  });
  it("reopening the modal resets a lateral drag and preserves the responder", () => {
    const close = vi.fn();
    let tree = render(close);
    tree
      .find((node) => node.type === "View")
      .props.onLayout({ nativeEvent: { layout: { width: 400, height: 800 } } });
    const originalResponder = hooks.pan;
    let transform = renderedTransform(tree);
    hooks.pan.onPanResponderGrant(touches(0));
    hooks.pan.onPanResponderMove(touches(0, 400));
    expect(nativePixels(transform)).toEqual({ zoom: 1, x: 200, y: 0 });
    tree = render(close);
    expect(hooks.pan).toBe(originalResponder);
    tree.find((node) => node.type === "Modal").props.onShow();
    transform = renderedTransform(tree);
    expect(transform[2].translateX.setValue).toHaveBeenLastCalledWith(0);
    expect(transform[3].translateY.setValue).toHaveBeenLastCalledWith(0);
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    expect(close).not.toHaveBeenCalled();
    hooks.pan.onPanResponderGrant(touches(0));
    hooks.pan.onPanResponderMove(touches(0, 0));
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    expect(close).toHaveBeenCalledOnce();
  });
  it("supports pinch and pan across renders and ten repeated close/open cycles", () => {
    const close = vi.fn();
    for (let iteration = 0; iteration < 10; iteration++) {
      let tree = render(close);
      tree
        .find((node) => node.type === "View")
        .props.onLayout({ nativeEvent: { layout: { width: 400, height: 800 } } });
      tree.find((node) => node.type === "Modal").props.onShow();
      const originalResponder = hooks.pan;
      hooks.pan.onPanResponderGrant(touches(100));
      hooks.pan.onPanResponderMove(touches(200));
      tree = render(close);
      expect(hooks.pan).toBe(originalResponder);
      expect(hooks.slots[0]).toEqual({ zoom: 2, x: 0, y: 0 });
      hooks.pan.onPanResponderEnd(touches(0));
      hooks.pan.onPanResponderMove(touches(0, 250));
      expect(hooks.slots[0]).toEqual({ zoom: 2, x: 50, y: 0 });
      hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
      hooks.pan.onPanResponderGrant(touches(0));
      hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
      vi.advanceTimersByTime(350);
      expect(close).toHaveBeenCalledTimes(iteration + 1);
      unmount();
    }
  });
  it("system close cancels pending single taps before unmount", () => {
    const close = vi.fn();
    const tree = render(close);
    hooks.pan.onPanResponderGrant(touches(0));
    hooks.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    tree.find((node) => node.type === "Modal").props.onRequestClose();
    vi.advanceTimersByTime(1000);
    expect(close).toHaveBeenCalledOnce();
  });
});

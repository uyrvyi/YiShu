import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import type { LetterView } from "../api/letterApi";

const h = vi.hoisted(() => ({
  cursor: 0, slots: [] as any[], pending: [] as Array<() => void>,
  session: 1, app: "active", reduce: false, width: 408, id: 0,
  changeApp: undefined as undefined | ((state: string) => void),
  alert: vi.fn(),
  animation: vi.fn(),
  Value: class {
    value: number;
    constructor(value: number) { this.value = value; }
    interpolate(config: unknown) { return { value: this, config }; }
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => `test-${h.id++}`,
  useState(initial: unknown) {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = initial;
    return [h.slots[i], (value: unknown) => { h.slots[i] = value; }];
  },
  useRef(value: unknown) { return h.slots[h.cursor++] ??= { current: value }; },
  useSyncExternalStore: () => h.session,
  useEffect(factory: () => (() => void) | void, deps: unknown[]) {
    const i = h.cursor++;
    const previous = h.slots[i];
    if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
      h.pending.push(() => { previous?.cleanup?.(); h.slots[i] = { deps, cleanup: factory() }; });
    }
  },
}));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Modal: "Modal", ScrollView: "ScrollView", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5, absoluteFill: { position: "absolute" } },
  useWindowDimensions: () => ({ width: h.width, height: 844 }),
  Easing: { cubic: "cubic", inOut: (value: unknown) => value, bezier: (...values: number[]) => values },
  AccessibilityInfo: { isReduceMotionEnabled: async () => h.reduce, addEventListener: () => ({ remove() {} }) },
  AppState: {
    get currentState() { return h.app; },
    addEventListener: (_: unknown, listener: (value: string) => void) => { h.changeApp = listener; return { remove() {} }; },
  },
  Alert: { alert: h.alert },
  Animated: {
    View: "AnimatedView", Value: h.Value,
    timing: (value: InstanceType<typeof h.Value>, config: { duration: number; toValue: number }) => {
      h.animation(config);
      let timer: ReturnType<typeof setTimeout>;
      return {
        start(done?: (result: { finished: boolean }) => void) {
          timer = setTimeout(() => { value.value = config.toValue; done?.({ finished: true }); }, config.duration);
        },
        stop() { clearTimeout(timer); },
      };
    },
  },
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView", SafeAreaProvider: "SafeAreaProvider", useSafeAreaInsets: () => ({ top: 59, bottom: 34 }) }));
vi.mock("react-native-svg", () => ({ default: "Svg", Circle: "Circle", Path: "Path", Rect: "Rect", Line: "Line", Defs: "Defs", ClipPath: "ClipPath", G: "G", Pattern: "Pattern", Text: "SvgText" }));
vi.mock("lucide-react-native", () => ({ X: "X" }));
vi.mock("../api", () => ({ getSessionVersion: () => h.session, subscribeSession: vi.fn() }));
vi.mock("../media/PrivateImage", () => ({ PrivateImages: "PrivateImages" }));
vi.mock("./LetterPaper", () => ({ PaperReader: "PaperReader" }));
import { ReadLetterRitual, SendLetterRitual } from "./LetterRitual";
import { ENVELOPE_GEOMETRY as EG, envelopeLayout } from "./envelopeGeometry";

function nodes(node: ReactNode): any[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<any>(node)) return [];
  const element = node as { type: unknown; props: { children?: ReactNode } };
  return [node, ...nodes(typeof element.type === "function"
    ? (element.type as (props: unknown) => ReactNode)(element.props) : element.props.children)];
}
function render(factory: () => ReactNode) {
  h.cursor = 0;
  const result = nodes(factory());
  h.pending.splice(0).forEach((effect) => effect());
  const envelope = result.find((node) => node.props.testID === "opening-envelope-frame");
  if (envelope && !envelope.props.ref.current) {
    const layout = envelopeLayout(Math.min(420, h.width - 48));
    envelope.props.ref.current = { measureInWindow: (done: (...frame: number[]) => void) => done(24, 302, layout.width, layout.height) };
    envelope.props.onLayout();
    return render(factory);
  }
  return result;
}
function unmount() { h.slots.forEach((slot) => slot?.cleanup?.()); }
async function settle() { await Promise.resolve(); await Promise.resolve(); }
const unopened = {
  trackingNo: "YS-TEST", status: "DELIVERED", readState: "UNOPENED", content: "私密正文",
  sender: { nickname: "小明" }, images: [{ id: "private-photo" }], writtenAt: "2026-10-07T00:00:00Z",
} as LetterView;
const opened = { ...unopened, readState: "OPENED" } as LetterView;
function sealButton(tree: any[]) {
  return tree.find((node) => node.props.accessibilityLabel === "点击骑缝章拆信");
}
beforeEach(() => {
  h.cursor = 0; h.slots = []; h.pending = []; h.session = 1; h.app = "active"; h.reduce = false; h.width = 408; h.id = 0;
  vi.clearAllMocks(); vi.useFakeTimers();
});
afterEach(() => { unmount(); vi.useRealTimers(); });

describe("寄信与拆信仪式", () => {
  it.each([320, 408, 768])("%ipx 屏幕下信封共用外框、闭合底折片、翻盖轴与骑缝章", (screenWidth) => {
    h.width = screenWidth;
    const layout = envelopeLayout(Math.min(420, screenWidth - 48));
    const send = render(() => SendLetterRitual({ ready: true, onComplete: vi.fn() }));
    unmount(); h.cursor = 0; h.slots = []; h.pending = [];
    const read = render(() => ReadLetterRitual({ letter: unopened, onOpen: vi.fn(), onClose: vi.fn(), onComplete: vi.fn(), onRevealed: vi.fn(), getPaperTarget: () => undefined }));
    for (const tree of [send, read]) {
      const arts = tree.filter((node) => ["envelope-back-art", "envelope-front-art", "envelope-flap-art"].includes(node.props.testID));
      expect(arts).toHaveLength(3);
      for (const art of arts) {
        const clip = nodes(art).find((node) => node.type === "ClipPath");
        expect(nodes(clip).find((node) => node.type === "Rect").props).toMatchObject({ x: 1, y: 1, width: 358, height: 238, rx: 8 });
        expect(art.props.width).toBe(layout.width);
        expect(art.props.height).toBe(art.props.testID === "envelope-flap-art" ? layout.flapHeight : layout.height);
      }
      expect(tree.filter((node) => node.props.testID === "envelope-outline")).toHaveLength(1);
      const bottom = tree.find((node) => node.type === "Path" && node.props.d === EG.bottom);
      expect(bottom.props.d).toBe("M1 239 L180 132 L359 239 Z");
      expect(bottom.props.stroke).toBeUndefined();
      expect(tree.find((node) => node.type === "Path" && node.props.d === EG.flap).props.d).toBe("M1 1 H359 L180 132 Z");
      expect(tree.find((node) => node.props.testID === "envelope-flap-art").props.viewBox).toBe("0 1 360 132");
    }
    const sendFlap = send.find((node) => node.props.testID === "sending-envelope-flap").props.style;
    const readFlap = read.find((node) => node.props.testID === "opening-envelope-flap").props.style;
    expect(sendFlap[0].transformOrigin).toBe("50% 0%");
    expect(readFlap[0]).toEqual(sendFlap[0]);
    expect(sendFlap[1].top - 80).toBeCloseTo(layout.hingeY);
    expect(readFlap[1].top).toBe(layout.hingeY);
    expect(sendFlap[1].transform[1].rotateX.config.outputRange).toEqual(["-178deg", "0deg"]);
    const sendSeal = send.find((node) => node.props.testID === "sending-envelope-seal").props.style[1];
    const readSeal = sealButton(read).props.style[1];
    expect(sendSeal.top - 80).toBeCloseTo(readSeal.top);
    expect(sendSeal.left).toBe(readSeal.left);
    expect(readSeal.left + EG.sealSize / 2).toBe(layout.width / 2);
    expect(readSeal.top + EG.sealSize / 2).toBeCloseTo(layout.height * 132 / 240);
  });
  it("装信和请求可以并行，但成功且装信完成后才封口，完成后只回调一次", async () => {
    const done = vi.fn();
    let ready = false;
    const view = () => SendLetterRitual({ ready, onComplete: done });
    render(view); await settle(); render(view);
    vi.advanceTimersByTime(900); render(view);
    expect(done).not.toHaveBeenCalled();
    ready = true; render(view);
    vi.advanceTimersByTime(899); expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); render(view); expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999); expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(done).toHaveBeenCalledTimes(1);
    render(view); vi.advanceTimersByTime(2000); expect(done).toHaveBeenCalledTimes(1);
  });
  it("后台暂停，返回前台继续；卸载不会完成导航", async () => {
    const done = vi.fn();
    const view = () => SendLetterRitual({ ready: true, onComplete: done });
    render(view); await settle(); render(view);
    h.app = "background"; h.changeApp?.(h.app); render(view);
    vi.advanceTimersByTime(2000); expect(done).not.toHaveBeenCalled();
    h.app = "active"; h.changeApp?.(h.app); render(view);
    vi.advanceTimersByTime(900); render(view);
    vi.advanceTimersByTime(900); render(view);
    h.app = "background"; h.changeApp?.(h.app); render(view);
    vi.advanceTimersByTime(2000); expect(done).not.toHaveBeenCalled();
    h.app = "active"; h.changeApp?.(h.app); render(view);
    vi.advanceTimersByTime(999); expect(done).not.toHaveBeenCalled();
    unmount(); vi.advanceTimersByTime(2000); expect(done).not.toHaveBeenCalled();
  });
  it("减少动态效果时使用短过渡，仍等待发送成功", async () => {
    h.reduce = true;
    const done = vi.fn();
    const view = () => SendLetterRitual({ ready: true, onComplete: done });
    render(view); await settle(); render(view);
    vi.advanceTimersByTime(100); render(view);
    vi.advanceTimersByTime(100); render(view); expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999); expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(done).toHaveBeenCalledTimes(1);
  });
  it("点击骑缝章只提交一次，非线性展开为信纸，收起后才回到详情", async () => {
    const open = vi.fn().mockResolvedValue(opened);
    const done = vi.fn();
    const revealed = vi.fn();
    const view = () => ReadLetterRitual({ letter: unopened, onOpen: open, onClose: vi.fn(), onComplete: done, onRevealed: revealed, getPaperTarget: () => undefined });
    let tree = render(view); await settle(); render(view);
    expect(tree.find((node) => node.type === "Modal").props).toMatchObject({ transparent: true, presentationStyle: "overFullScreen" });
    expect(tree.find((node) => node.props.testID === "opening-envelope-front").props.style.opacity.config.inputRange).toEqual([0, 0.6, 1]);
    expect(tree.some((node) => node.type === "PrivateImages")).toBe(false);
    expect(tree.filter((node) => node.type === "Svg").some((node) => node.props.width === 360 && node.props.height === 240)).toBe(true);
    const button = sealButton(tree);
    expect(open).not.toHaveBeenCalled();
    button.props.onPress(); button.props.onPress(); expect(open).toHaveBeenCalledTimes(1);
    await settle(); tree = render(view);
    expect(tree.some((node) => node.type === "PrivateImages")).toBe(false);
    const initialPaper = tree.find((node) => node.type === "PaperReader");
    expect(initialPaper.props.entranceFrame).toEqual({ x: 24, y: 302, width: 360, height: 240 });
    expect(h.animation).not.toHaveBeenCalled();
    initialPaper.props.onMeasured(); tree = render(view);
    expect(h.animation).toHaveBeenCalledWith(expect.objectContaining({ easing: [0.4, 0, 0.2, 1], duration: 1400, useNativeDriver: false }));
    expect(tree.some((node) => node.type === "Svg" && node.props.viewBox === "0 0 300 210")).toBe(false);
    button.props.onPress(); expect(open).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1399); expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); tree = render(view);
    expect(revealed).toHaveBeenCalledWith(opened);
    expect(done).not.toHaveBeenCalled();
    const paper = tree.find((node) => node.type === "PaperReader");
    expect(paper.props.ready).toBe(true);
    paper.props.onClose(); paper.props.onClose();
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(opened);
    expect(tree.some((node) => node.props.children === "私密正文")).toBe(false);
  });
  it("失败弹窗且允许重试；关闭后晚到的请求不揭示正文", async () => {
    let resolve!: (value: LetterView) => void;
    const open = vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const close = vi.fn();
    const done = vi.fn();
    const view = () => ReadLetterRitual({ letter: unopened, onOpen: open, onClose: close, onComplete: done, onRevealed: vi.fn(), getPaperTarget: () => undefined });
    let tree = render(view); await settle(); tree = render(view);
    sealButton(tree).props.onPress(); await settle();
    expect(h.alert).toHaveBeenCalledTimes(1);
    tree = render(view); sealButton(tree).props.onPress(); expect(open).toHaveBeenCalledTimes(2);
    tree.find((node) => node.props.accessibilityLabel === "关闭信封").props.onPress();
    resolve(opened); await settle(); tree = render(view);
    expect(close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000); expect(done).not.toHaveBeenCalled();
    expect(tree.some((node) => node.type === "PrivateImages")).toBe(false);
  });
  it("切换账号即隐藏信封，不继续打开内容", () => {
    const open = vi.fn();
    const view = () => ReadLetterRitual({ letter: unopened, onOpen: open, onClose: vi.fn(), onComplete: vi.fn(), onRevealed: vi.fn(), getPaperTarget: () => undefined });
    render(view);
    expect(open).not.toHaveBeenCalled();
    h.session = 2; expect(render(view)).toEqual([]);
  });
  it("骑缝章保留按钮无障碍语义，后台不可触发", () => {
    const open = vi.fn().mockImplementation(() => new Promise(() => {}));
    const view = () => ReadLetterRitual({ letter: unopened, onOpen: open, onClose: vi.fn(), onComplete: vi.fn(), onRevealed: vi.fn(), getPaperTarget: () => undefined });
    let tree = render(view);
    h.app = "background"; h.changeApp?.(h.app); tree = render(view);
    sealButton(tree).props.onPress(); expect(open).not.toHaveBeenCalled();
    h.app = "active"; h.changeApp?.(h.app); tree = render(view);
    const seal = sealButton(tree);
    expect(seal.props.accessibilityRole).toBe("button");
    seal.props.onPress(); seal.props.onPress();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("信纸阅读浮层", () => {
  it("短信纸在安全区内居中，长信纸从顶部整张滚动且不额外撑高", async () => {
    const { PaperReader } = await vi.importActual<typeof import("./LetterPaper")>("./LetterPaper");
    const view = () => PaperReader({ letter: opened, getTarget: () => undefined, onClose: vi.fn() });
    let tree = render(view);
    const sheet = tree.find((node) => node.props.testID === "reading-paper-content");
    sheet.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
    tree = render(view);
    const gap = (844 - (59 + 16) - (34 + 16) - 300) / 2;
    expect(tree.find((node) => node.props.testID === "paper-reader-top-space").props.style.height).toBe(gap);
    expect(tree.find((node) => node.props.testID === "paper-reader-bottom-space").props.style.minHeight).toBe(gap);
    sheet.props.onLayout({ nativeEvent: { layout: { height: 1200 } } });
    tree = render(view);
    expect(tree.find((node) => node.props.testID === "paper-reader-top-space").props.style.height).toBe(0);
    expect(tree.find((node) => node.props.testID === "paper-reader-bottom-space").props.style.minHeight).toBe(0);
    expect(tree.filter((node) => node.type === "ScrollView")).toHaveLength(1);
  });
  it("正文轻点缩回实测组件位置；滑动正文不收起，图片保留独立预览", async () => {
    const { PaperReader } = await vi.importActual<typeof import("./LetterPaper")>("./LetterPaper");
    const done = vi.fn();
    const destination = { x: 24, y: 280, width: 360, height: 300 };
    const view = () => PaperReader({ letter: opened, getTarget: () => destination, onClose: done });
    let tree = render(view); await settle(); tree = render(view);
    const scroll = tree.find((node) => node.type === "ScrollView");
    const sheet = tree.find((node) => node.props.testID === "reading-paper-content");
    expect(sheet.props.style.height).toBeUndefined();
    expect(nodes(scroll.props.children).some((node) => node === sheet)).toBe(true);
    expect(tree.filter((node) => node.type === "ScrollView")).toHaveLength(1);
    scroll.props.onTouchStart({ nativeEvent: { pageX: 100, pageY: 100 } });
    scroll.props.onTouchMove({ nativeEvent: { pageX: 100, pageY: 130 } });
    const textTap = tree.find((node) => node.type === "Pressable" && nodes(node.props.children).some((child) => child.props.children === "私密正文"));
    textTap.props.onPress(); render(view); vi.advanceTimersByTime(500);
    expect(done).not.toHaveBeenCalled();
    expect(tree.find((node) => node.type === "PrivateImages").props.images).toEqual(opened.images);
    scroll.props.onTouchStart({ nativeEvent: { pageX: 100, pageY: 100 } });
    textTap.props.onPress(); textTap.props.onPress(); tree = render(view);
    expect(h.animation).toHaveBeenCalledWith(expect.objectContaining({ duration: 360, toValue: 1 }));
    vi.advanceTimersByTime(359); expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(done).toHaveBeenCalledTimes(1);
  });
  it("未拆阅内容不能进入信纸组件或阅读浮层", async () => {
    const { LetterPaper, PaperReader } = await vi.importActual<typeof import("./LetterPaper")>("./LetterPaper");
    expect(LetterPaper({ letter: unopened, onPress: vi.fn() })).toBeNull();
    expect(render(() => PaperReader({ letter: unopened, getTarget: () => undefined, onClose: vi.fn() }))).toEqual([]);
  });
  it("同一张真实信纸从实测信封抽出，保持可见并连续展开，动画中不能滚动", async () => {
    const { PaperReader } = await vi.importActual<typeof import("./LetterPaper")>("./LetterPaper");
    const entrance = new h.Value(0) as any;
    const measured = vi.fn();
    let ready = false;
    const view = () => PaperReader({ letter: opened, entrance, fromEnvelope: true,
      entranceFrame: { x: 24, y: 302, width: 360, height: 240 }, onMeasured: measured,
      ready, getTarget: () => undefined, onClose: vi.fn() });
    let tree = render(view);
    const content = tree.find((node) => node.props.testID === "reading-paper-content");
    content.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
    tree = render(view);
    const surface = tree.find((node) => node.props.testID === "continuous-reading-paper");
    expect(surface.props.style.opacity).toBe(1);
    expect(surface.props.style.transformOrigin).toBe("50% 0%");
    const stacking = tree.find((node) => node.props.testID === "paper-reader").props.style[1].zIndex.config;
    expect(stacking.inputRange).toEqual([0, 0.59, 0.6, 1]);
    expect(stacking.outputRange).toEqual([0, 0, 2, 2]);
    const scale = 360 * 0.84 / 376;
    expect(surface.props.style.transform[2].scale.config.outputRange).toEqual([scale, scale, scale, 1]);
    expect(tree.find((node) => node.type === "ScrollView").props.scrollEnabled).toBe(false);
    expect(measured).toHaveBeenCalledTimes(1);
    entrance.value = 1; ready = true; tree = render(view);
    expect(tree.filter((node) => node.props.testID === "reading-paper-content")).toHaveLength(1);
    expect(tree.find((node) => node.props.testID === "continuous-reading-paper").props.style.opacity).toBe(1);
    expect(tree.find((node) => node.type === "ScrollView").props.scrollEnabled).toBe(true);
  });
});

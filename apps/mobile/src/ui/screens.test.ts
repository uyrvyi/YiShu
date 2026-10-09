import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import type { LetterView } from "../api/letterApi";
import type { RouteMapViewParsed } from "@yishu/shared";
import { formatFactTime } from "../map/presentation";

// Match the repository's native-host substitution tests; these check structure, not device layout.
const harness = vi.hoisted(() => ({
  state: new Map<number, unknown>(),
  cursor: 0,
  refCursor: 0,
  refs: [] as unknown[],
  persistentRefs: false,
  polls: [] as unknown[],
  pollCursor: 0,
  navigate: vi.fn(),
  pan: {} as Record<string, (...args: unknown[]) => unknown>,
  params: {} as Record<string, string>,
  deleteImage: vi.fn(),
  uploadImage: vi.fn(),
  createLetter: vi.fn(),
  initializeJourney: vi.fn(),
  openLetter: vi.fn(),
  getLetter: vi.fn(),
  searchRecipient: vi.fn(),
  getCurrentUser: vi.fn(),
  preparePreview: vi.fn(),
  optimizeImage: vi.fn(),
  encryptionStatus: vi.fn(),
  encryptionPrepare: vi.fn(),
  encryptionActivate: vi.fn(),
  encryptionRecover: vi.fn(),
  encryptionVerify: vi.fn(),
  encryptionEnsure: vi.fn(),
  encryptionBackup: vi.fn(),
  animate: vi.fn(),
  scheme: "light" as "light" | "dark",
  preference: "system" as "light" | "dark" | "system",
  selectAppearance: vi.fn(),
}));

vi.mock("./ThemeProvider", async () => {
  const { C, DARK_COLORS } = await import("./theme");
  return {
    useAppTheme: () => ({ colors: harness.scheme === "dark" ? DARK_COLORS : C, scheme: harness.scheme,
      preference: harness.preference, saving: false, select: harness.selectAppearance }),
    useThemedStyles: (factory: (colors: typeof DARK_COLORS) => unknown) => factory(harness.scheme === "dark" ? DARK_COLORS : C),
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    const value = harness.state.has(index) ? harness.state.get(index) : initial;
    return [
      value,
      (next: unknown) =>
        harness.state.set(
          index,
          typeof next === "function"
            ? next(harness.state.has(index) ? harness.state.get(index) : initial)
            : next
        ),
    ];
  },
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
  useRef: (current: unknown) => harness.persistentRefs
    ? (harness.refs[harness.refCursor++] ??= { current }) : ({ current }),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

vi.mock("react-native", () => ({
  StyleSheet: {
    create: (styles: unknown) => styles,
    hairlineWidth: 0.5,
    flatten: (style: unknown) => style,
    absoluteFillObject: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  },
  View: "View",
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  Animated: {
    View: "AnimatedView",
    Value: class {
      setValue = vi.fn();
      stopAnimation = vi.fn();
    },
    spring: () => ({
      start: (done: (result: { finished: boolean }) => void) => done({ finished: true }),
    }),
    timing: (_value: unknown, config: unknown) => {
      harness.animate(config);
      return { start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }) };
    },
  },
  PanResponder: {
    create: (config: typeof harness.pan) => {
      harness.pan = config;
      return { panHandlers: {} };
    },
  },
  Text: "Text",
  TextInput: "TextInput",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  FlatList: "FlatList",
  RefreshControl: "RefreshControl",
  ActivityIndicator: "ActivityIndicator",
  Image: "Image",
  SafeAreaView: "SafeAreaView",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Modal: "Modal",
  Platform: { OS: "ios", Version: 27 },
  Alert: { alert: vi.fn() },
  Keyboard: { dismiss: vi.fn() },
  AppState: { addEventListener: vi.fn() },
  Linking: { openSettings: vi.fn() },
  AccessibilityInfo: { addEventListener: vi.fn(), isReduceTransparencyEnabled: vi.fn() },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: "SafeAreaView",
  SafeAreaProvider: "SafeAreaProvider",
  useSafeAreaInsets: () => ({ top: 59, bottom: 34 }),
}));
vi.mock("expo-glass-effect", () => ({
  GlassView: "GlassView",
  isLiquidGlassAvailable: () => true,
  isGlassEffectAPIAvailable: () => true,
}));
vi.mock("expo-blur", () => ({ BlurView: "BlurView" }));
vi.mock("react-native-svg", () => ({ default: "Svg", Circle: "SvgCircle" }));
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: vi.fn() }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: vi.fn() }));
vi.mock("expo-file-system", () => ({
  File: class {
    exists = false;
  },
}));
vi.mock("expo-image-manipulator", () => ({ ImageManipulator: {}, SaveFormat: { JPEG: "jpeg" } }));
vi.mock("../media/draftPreview", () => ({ prepareDraftPreview: harness.preparePreview }));
vi.mock("../media/uploadPreparation", () => ({
  MAX_IMAGE_BYTES: 10 * 1024 * 1024,
  AVATAR_JPEG_QUALITY: 0.85,
  prepareUploadImage: harness.optimizeImage,
  uploadFormat: () => ({ format: "jpeg", mimeType: "image/jpeg", extension: ".jpg" }),
}));
vi.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: vi.fn(),
  Accuracy: { Balanced: 3 },
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
  SchedulableTriggerInputTypes: { TIME_INTERVAL: "timeInterval" },
}));
vi.mock("lucide-react-native", () => ({
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUpRight: "ArrowUpRight",
  ArrowDownLeft: "ArrowDownLeft",
  Bell: "Bell",
  BellRing: "BellRing",
  Check: "Check",
  ChevronDown: "ChevronDown",
  ChevronUp: "ChevronUp",
  ChevronRight: "ChevronRight",
  CircleAlert: "CircleAlert",
  Clock3: "Clock3",
  EyeOff: "EyeOff",
  FolderOpen: "FolderOpen",
  ImagePlus: "ImagePlus",
  Info: "Info",
  LockKeyhole: "LockKeyhole",
  LogIn: "LogIn",
  LogOut: "LogOut",
  LocateFixed: "LocateFixed",
  Layers: "Layers",
  ShieldCheck: "ShieldCheck",
  Sun: "Sun",
  Moon: "Moon",
  Smartphone: "Smartphone",
  SunMoon: "SunMoon",
  KeyRound: "KeyRound",
  Mail: "Mail",
  MailOpen: "MailOpen",
  MapPin: "MapPin",
  PackageSearch: "PackageSearch",
  Plus: "Plus",
  Search: "Search",
  Send: "Send",
  RotateCw: "RotateCw",
  RotateCcw: "RotateCcw",
  Minus: "Minus",
  UserRound: "UserRound",
  X: "X",
}));
vi.mock("expo-router", () => ({
  Redirect: "Redirect",
  router: {
    push: harness.navigate,
    replace: harness.navigate,
    back: harness.navigate,
    canGoBack: () => false,
  },
  useLocalSearchParams: () => ({ trackingNo: "YS-TEST", ...harness.params }),
}));
vi.mock("expo-constants", () => ({
  default: { executionEnvironment: "storeClient", nativeAppVersion: "57.0" },
}));
vi.mock("../api", () => ({
  encryptionClient: {
    ensureReady: harness.encryptionEnsure,
    backupRecoveryCode: harness.encryptionBackup,
    status: harness.encryptionStatus,
    prepareEnrollment: harness.encryptionPrepare,
    activate: harness.encryptionActivate,
    recover: harness.encryptionRecover,
    verifyContact: harness.encryptionVerify,
  },
  getApi: () => ({
    deleteStagedImage: harness.deleteImage, uploadImage: harness.uploadImage,
    createLetter: harness.createLetter, initializeJourney: harness.initializeJourney,
    openLetter: harness.openLetter, getLetter: harness.getLetter,
    searchRecipient: harness.searchRecipient, getCurrentUser: harness.getCurrentUser,
  }),
  getSessionVersion: () => 1,
  isAuthenticated: vi.fn(),
  subscribeSession: vi.fn(),
  restoreSession: vi.fn(),
  loginSession: vi.fn(),
  registerSession: vi.fn(),
  logoutSession: vi.fn(),
}));
vi.mock("../refresh/usePolling", () => ({
  usePolling: () => ({ data: harness.polls[harness.pollCursor++], error: null, refresh: vi.fn() }),
}));
vi.mock("../map/InteractiveRouteMap", () => ({ InteractiveRouteMap: "InteractiveRouteMap" }));
vi.mock("../letters/LetterRitual", () => ({ SendLetterRitual: "SendLetterRitual", ReadLetterRitual: "ReadLetterRitual" }));

import LettersScreen from "../../app/letters/index";
import LetterDetailScreen from "../../app/letters/[trackingNo]";
import LogisticsScreen from "../../app/letters/[trackingNo]/logistics";
import NewLetterScreen from "../../app/letters/new";
import HomeScreen from "../../app/index";
import MeScreen from "../../app/me";
import EncryptionScreen from "../../app/encryption";
import ProfileScreen from "../../app/profile";
import AppearanceScreen from "../../app/appearance";
import { AvatarCropper } from "../media/AvatarCropper";
import { ImagePreview } from "../media/ImagePreview";
import { PrivateImages } from "../media/PrivateImage";
import { UploadProgressRing } from "../media/UploadProgressRing";
import { RegionSelector } from "../regions/RegionSelector";
import { BottomNav } from "./BottomNav";
import { ActionButton, FormInput, KeyboardFrame, ScreenHeader } from "./controls";
import { C, UI } from "./theme";
import { glassMaterial, GlassSurface, getGlassDiagnostics } from "./GlassSurface";

type Element = { type: unknown; props: Record<string, unknown> & { children?: ReactNode } };
function elements(node: ReactNode, out: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const element = node as Element;
  out.push(element);
  if (element.type === "Modal" && !element.props.visible) return out;
  if (element.type === "FlatList") elements(element.props.ListHeaderComponent as ReactNode, out);
  if (typeof element.type === "function") {
    elements((element.type as (props: Record<string, unknown>) => ReactNode)(element.props), out);
  } else elements(element.props.children, out);
  return out;
}
function text(tree: Element[]): string[] {
  return tree
    .filter((node) => node.type === "Text")
    .map((node) =>
      Array.isArray(node.props.children)
        ? node.props.children.join("")
        : String(node.props.children ?? "")
    );
}
function button(tree: Element[], label: string): Element {
  const found = tree.find(
    (node) => node.type === "Pressable" && node.props.accessibilityLabel === label
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function press(node: Element) {
  (node.props.onPress as () => void)();
}
function rerender() {
  harness.cursor = 0;
  harness.refCursor = 0;
  harness.pollCursor = 0;
}

const letter: LetterView = {
  trackingNo: "YS-TEST",
  status: "IN_TRANSIT",
  initialTransport: "HORSE_RELAY",
  currentTransport: "HORSE_RELAY",
  origin: { province: "上海市", city: "上海市", district: "徐汇区" },
  target: { province: "北京市", city: "北京市", district: "海淀区" },
  sentAt: "2026-09-01T00:00:00Z",
  createdAt: "2026-09-01T00:00:00Z",
  deliveredAt: null,
  content: "只给收件人看的正文",
  sender: { account: "alice", uid: "12345678", nickname: "寄件人" },
  recipient: { account: "bobx", uid: "87654321", nickname: "收件人" },
};
const facts = Array.from({ length: 6 }, (_, index) => ({
  type: "ARRIVED_STATION",
  title: `动态 ${index}`,
  location: { province: "上海市", city: "上海市" },
  happenedAt: `2026-09-0${index + 1}T00:00:00Z`,
  description: "已确认事实",
}));
const map: RouteMapViewParsed = {
  status: "IN_TRANSIT",
  origin: null,
  destination: null,
  completedPath: [{ x: 800, y: 200 }],
  remainingPath: [],
  approximatePosition: null,
  lastKnownPosition: { x: 800, y: 200 },
  facts: [],
};

beforeEach(() => {
  harness.scheme = "light";
  harness.preference = "system";
  harness.state.clear();
  harness.refs = [];
  harness.persistentRefs = false;
  harness.polls = [];
  harness.params = {};
  rerender();
  vi.clearAllMocks();
  harness.deleteImage.mockResolvedValue(undefined);
  harness.preparePreview.mockResolvedValue("data:image/jpeg;base64,anBlZw==");
  harness.optimizeImage.mockImplementation(async (input) => input);
  harness.uploadImage.mockResolvedValue({ id: "staged-image" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("移动端页面结构与交互", () => {
  it("appearance settings expose three radios and a current-value entry", () => {
    vi.stubGlobal("__DEV__", false);
    const me = elements(MeScreen());
    press(button(me, "界面设置"));
    expect(harness.navigate).toHaveBeenCalledWith("/appearance");
    expect(text(me)).toContain("跟随系统");
    rerender();
    let tree = elements(AppearanceScreen());
    const options = tree.filter((node) => node.props.accessibilityRole === "radio");
    expect(options).toHaveLength(3);
    expect(options.map((node) => node.props.accessibilityState)).toEqual([
      { checked: false, disabled: false }, { checked: false, disabled: false }, { checked: true, disabled: false },
    ]);
    press(options[1]); expect(harness.selectAppearance).toHaveBeenCalledWith("dark");
    harness.preference = "dark"; harness.scheme = "dark"; rerender(); tree = elements(AppearanceScreen());
    expect(tree.find((node) => node.props.accessibilityLabel === "深色模式")?.props.accessibilityState).toEqual({ checked: true, disabled: false });
  });
  it("theme changes retain the composer draft and recolor its controls", () => {
    let tree = elements(NewLetterScreen());
    const input = tree.find((node) => node.props.accessibilityLabel === "信件正文")!;
    (input.props.onChangeText as (value: string) => void)("仍在写的草稿");
    harness.scheme = "dark"; rerender(); tree = elements(NewLetterScreen());
    expect(tree.find((node) => node.props.accessibilityLabel === "信件正文")?.props.value).toBe("仍在写的草稿");
    const label = tree.find((node) => node.type === "Text" && node.props.children === "正文")!;
    expect(label.props.style).toMatchObject({ color: "#F1F4F6" });
  });
  it("加密设置区分安全码和用户编号，初始化不要求手动开启", () => {
    harness.state.set(0, { uid: "12345678", enabled: false, available: false, identity: null });
    const tree = elements(EncryptionScreen());
    expect(text(tree)).toContain("我的安全码");
    expect(text(tree)).toContain("用户编号");
    expect(text(tree)).toContain("正在准备本机密钥");
    expect(text(tree)).not.toContain("开启加密");
    expect(text(tree)).not.toContain("核对联系人安全码");
  });
  it("恢复码仅在丢失本机密钥时需要输入，不自动生成替代密钥", () => {
    harness.state.set(0, { uid: "12345678", enabled: true, available: false, identity: null });
    const tree = elements(EncryptionScreen());
    expect(button(tree, "恢复密钥").props.disabled).toBe(true);
    expect(
      tree.some((node) => node.props.accessibilityLabel === "恢复码" && node.props.secureTextEntry)
    ).toBe(true);
  });
  function preview(onClose: () => void) {
    const tree = elements(ImagePreview({ children: "pixels", aspectRatio: 0.5, onClose }));
    const viewport = tree.find((node) => node.props.testID === "image-preview-viewport");
    (viewport?.props.onLayout as (event: unknown) => void)({
      nativeEvent: { layout: { width: 400, height: 800 } },
    });
    return tree;
  }
  function touch(x = 200, y = 400) {
    return {
      nativeEvent: {
        pageX: x,
        pageY: y,
        locationX: x,
        locationY: y,
        touches: [{ pageX: x, pageY: y }],
      },
    };
  }
  function tap(x = 200, y = 400) {
    harness.pan.onPanResponderGrant(touch(x, y));
    harness.pan.onPanResponderRelease(touch(x, y));
  }
  it("全屏预览单击任意位置延迟关闭，不显示返回按钮", () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const tree = preview(close);
    expect(tree.some((node) => node.type === "Pressable")).toBe(false);
    tap(5, 5);
    vi.advanceTimersByTime(349);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledOnce();
  });
  it("双击放大、再次双击复原，两次操作都不关闭预览", () => {
    vi.useFakeTimers();
    const close = vi.fn();
    preview(close);
    tap();
    vi.advanceTimersByTime(100);
    tap();
    expect(harness.animate).toHaveBeenLastCalledWith(
      expect.objectContaining({ toValue: 2.5, useNativeDriver: true })
    );
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
    tap();
    vi.advanceTimersByTime(100);
    tap();
    expect(harness.animate).toHaveBeenLastCalledWith(expect.objectContaining({ toValue: 1 }));
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
  });
  it("放大后的拖动与多指触摸不会被误判为关闭", () => {
    vi.useFakeTimers();
    const close = vi.fn();
    preview(close);
    tap();
    vi.advanceTimersByTime(100);
    tap();
    harness.pan.onPanResponderGrant(touch());
    harness.pan.onPanResponderMove(touch(1199, -599));
    harness.pan.onPanResponderRelease(touch());
    expect(harness.state.get(0)).toEqual({ zoom: 2.5, x: 300, y: -600 });
    const multi = touch();
    multi.nativeEvent.touches.push({ pageX: 220, pageY: 420 });
    harness.pan.onPanResponderGrant(multi);
    harness.pan.onPanResponderRelease(multi);
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
  });
  it("较慢的双击和轻微手指漂移仍放大，不提前关闭", () => {
    vi.useFakeTimers();
    const close = vi.fn();
    preview(close);
    tap();
    vi.advanceTimersByTime(320);
    harness.pan.onPanResponderGrant(touch(230, 410));
    harness.pan.onPanResponderMove(touch(239, 415));
    vi.advanceTimersByTime(60);
    harness.pan.onPanResponderRelease(touch(239, 415));
    expect(harness.animate).toHaveBeenLastCalledWith(expect.objectContaining({ toValue: 2.5 }));
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
  });
  function pinch(distance: number, x = 200, y = 400) {
    const event = touch();
    event.nativeEvent.touches = [
      { pageX: x - distance / 2, pageY: y },
      { pageX: x + distance / 2, pageY: y },
    ];
    return event;
  }
  it("获权事件缺少触点时，后续第二指到达仍能初始化并缩放", () => {
    const close = vi.fn();
    preview(close);
    const empty = touch();
    empty.nativeEvent.touches = [];
    harness.pan.onPanResponderGrant(empty);
    harness.pan.onPanResponderStart(pinch(100));
    harness.pan.onPanResponderMove(pinch(200));
    expect(harness.state.get(0)).toEqual({ zoom: 2, x: 0, y: 0 });
    expect(close).not.toHaveBeenCalled();
  });
  it("多指在捕获阶段接管，活动手势不被子视图夺走", () => {
    preview(vi.fn());
    expect(harness.pan.onStartShouldSetPanResponderCapture(touch())).toBe(false);
    expect(harness.pan.onStartShouldSetPanResponderCapture(pinch(100))).toBe(true);
    expect(harness.pan.onMoveShouldSetPanResponderCapture(pinch(100))).toBe(true);
    harness.pan.onPanResponderGrant(pinch(100));
    expect(harness.pan.onPanResponderTerminationRequest()).toBe(false);
  });
  it("弹窗重新显示时复原缩放与点击状态，随后捏合正常", () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const tree = preview(close);
    tap();
    const modal = tree.find((node) => node.type === "Modal");
    (modal?.props.onShow as () => void)();
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
    harness.pan.onPanResponderGrant(pinch(100));
    harness.pan.onPanResponderMove(pinch(200));
    expect(harness.state.get(0)).toEqual({ zoom: 2, x: 0, y: 0 });
    (modal?.props.onShow as () => void)();
    expect(harness.state.get(0)).toEqual({ zoom: 1, x: 0, y: 0 });
    harness.pan.onPanResponderGrant(pinch(100));
    harness.pan.onPanResponderMove(pinch(300));
    expect(harness.state.get(0)).toEqual({ zoom: 3, x: 0, y: 0 });
  });
  it("双指张开和合拢连续缩放，缩回原大小时不关闭", () => {
    vi.useFakeTimers();
    const close = vi.fn();
    preview(close);
    harness.pan.onPanResponderGrant(pinch(100));
    harness.pan.onPanResponderMove(pinch(200));
    expect(harness.state.get(0)).toEqual({ zoom: 2, x: 0, y: 0 });
    harness.pan.onPanResponderMove(pinch(600));
    expect(harness.state.get(0)).toEqual({ zoom: 5, x: 0, y: 0 });
    harness.pan.onPanResponderMove(pinch(100));
    expect(harness.state.get(0)).toEqual({ zoom: 1, x: 0, y: 0 });
    harness.pan.onPanResponderRelease(pinch(100));
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
  });
  it("加入第二根手指及捏合后抬起一指不会跳动或误关", () => {
    vi.useFakeTimers();
    const close = vi.fn();
    preview(close);
    harness.pan.onPanResponderGrant(touch());
    harness.pan.onPanResponderStart(pinch(100));
    harness.pan.onPanResponderMove(pinch(200));
    expect(harness.state.get(0)).toEqual({ zoom: 2, x: 0, y: 0 });
    harness.pan.onPanResponderEnd(touch());
    harness.pan.onPanResponderMove(touch(250, 400));
    expect(harness.state.get(0)).toEqual({ zoom: 2, x: 50, y: 0 });
    harness.pan.onPanResponderRelease(touch(250, 400));
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
  });
  it.each([
    [120, 0],
    [-120, 0],
    [0, 120],
    [0, -120],
    [80, 80],
  ])("原始大小短拖 (%i, %i) 两轴回弹而不关闭", (dx, dy) => {
    vi.useFakeTimers();
    const close = vi.fn();
    preview(close);
    harness.pan.onPanResponderGrant(touch());
    harness.pan.onPanResponderMove(touch(200 + dx, 400 + dy));
    harness.animate.mockClear();
    harness.pan.onPanResponderRelease(touch(200 + dx, 400 + dy));
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
    expect(harness.animate).toHaveBeenCalledTimes(2);
    expect(harness.animate.mock.calls).toEqual([
      [expect.objectContaining({ toValue: 0, useNativeDriver: true })],
      [expect.objectContaining({ toValue: 0, useNativeDriver: true })],
    ]);
  });
  it.each([
    [200, 0],
    [-200, 0],
    [0, 200],
    [0, -200],
    [110, 110],
    [-110, -110],
    [110, -110],
    [-110, 110],
  ])("原始大小拖动 (%i, %i) 超过距离阈值后松手退出", (dx, dy) => {
    const close = vi.fn();
    preview(close);
    harness.pan.onPanResponderGrant(touch());
    harness.pan.onPanResponderMove(touch(200 + dx, 400 + dy));
    expect(close).not.toHaveBeenCalled();
    harness.pan.onPanResponderRelease(touch(200 + dx, 400 + dy));
    expect(close).toHaveBeenCalledOnce();
  });
  it.each([
    [0, 200],
    [200, 0],
    [-200, 0],
    [0, -200],
  ])("拖动 (%i, %i) 后加入第二指取消退出手势，不误关图片", (dx, dy) => {
    vi.useFakeTimers();
    const close = vi.fn();
    preview(close);
    harness.pan.onPanResponderGrant(touch());
    harness.pan.onPanResponderMove(touch(200 + dx, 400 + dy));
    harness.pan.onPanResponderStart(pinch(100));
    harness.pan.onPanResponderRelease(pinch(100));
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
  });
  it("原始大小拖过阈值后拖回，按松手位置回弹而不退出", () => {
    const close = vi.fn();
    preview(close);
    harness.pan.onPanResponderGrant(touch());
    harness.pan.onPanResponderMove(touch(400, 400));
    harness.pan.onPanResponderMove(touch(205, 400));
    harness.pan.onPanResponderRelease(touch(205, 400));
    expect(close).not.toHaveBeenCalled();
  });
  it.each([
    [200, 0],
    [-200, 0],
    [0, 200],
    [0, -200],
  ])("原始大小双指平移 (%i, %i) 永不触发退出", (dx, dy) => {
    vi.useFakeTimers();
    const close = vi.fn();
    preview(close);
    harness.pan.onPanResponderGrant(pinch(100));
    harness.pan.onPanResponderMove(pinch(100, 200 + dx, 400 + dy));
    harness.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
    expect(harness.state.get(0)).toEqual({ zoom: 1, x: 0, y: 0 });
  });
  it("双指缩回原大小后抬起一指继续移动，也不触发退出", () => {
    vi.useFakeTimers();
    const close = vi.fn();
    preview(close);
    harness.pan.onPanResponderGrant(pinch(100));
    harness.pan.onPanResponderMove(pinch(200));
    harness.pan.onPanResponderMove(pinch(100, 300, 600));
    harness.pan.onPanResponderEnd(touch());
    harness.pan.onPanResponderMove(touch(500, 700));
    harness.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
    harness.pan.onPanResponderGrant(touch());
    harness.pan.onPanResponderMove(touch(400, 400));
    harness.pan.onPanResponderRelease({ nativeEvent: { touches: [] } });
    expect(close).toHaveBeenCalledOnce();
  });
  it("Android 系统返回关闭预览，终止手势不残留关闭计时器", () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const tree = preview(close);
    tap();
    harness.pan.onPanResponderTerminate();
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
    const modal = tree.find((node) => node.type === "Modal");
    (modal?.props.onRequestClose as () => void)();
    expect(close).toHaveBeenCalledOnce();
  });
  it("准备独立预览像素后上传选图优化文件，不把预览作为正文上传", async () => {
    const picker = await import("../media/picker");
    const image = { uri: "file:original.png", name: "original.png", mimeType: "image/png" };
    vi.spyOn(picker, "pickImages").mockResolvedValueOnce([image]);
    press(button(elements(NewLetterScreen()), "从相册添加图片"));
    await vi.waitFor(() =>
      expect(harness.uploadImage).toHaveBeenCalledWith(image, false, expect.any(Function))
    );
    expect(harness.preparePreview).toHaveBeenCalledWith(image.uri, image.mimeType);
    expect(harness.state.get(0)).toEqual([
      { id: "staged-image", localUri: "data:image/jpeg;base64,anBlZw==" },
    ]);
  });
  it("预览生成失败时弹窗且不产生没有预览的待发送图片", async () => {
    const { Alert } = await import("react-native");
    const picker = await import("../media/picker");
    vi.spyOn(picker, "pickImages").mockResolvedValueOnce([
      { uri: "file:broken", name: "photo.png", mimeType: "image/png" },
    ]);
    harness.preparePreview.mockRejectedValueOnce(new Error("decode failed"));
    press(button(elements(NewLetterScreen()), "从文件添加图片"));
    await vi.waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith("图片未上传", expect.any(String))
    );
    expect(harness.uploadImage).not.toHaveBeenCalled();
  });
  it.each(["album", "files"] as const)(
    "%s 图片上传成功显示缩略图，不弹成功提示",
    async (source) => {
      const { Alert } = await import("react-native");
      const picker = await import("../media/picker");
      vi.spyOn(picker, "pickImages").mockResolvedValueOnce([
        { uri: "file:photo.png", name: "photo.png", mimeType: "image/png" },
      ]);
      press(
        button(
          elements(NewLetterScreen()),
          source === "album" ? "从相册添加图片" : "从文件添加图片"
        )
      );
      await vi.waitFor(() => expect(harness.state.get(15)).toEqual([]));
      expect(harness.state.get(0)).toHaveLength(1);
      rerender();
      expect(
        elements(NewLetterScreen()).some(
          (node) => node.type === "Image" && node.props.resizeMode === "cover"
        )
      ).toBe(true);
      expect(Alert.alert).not.toHaveBeenCalled();
    }
  );
  it("选中的图片在上传完成前显示缩略图、独立进度和排队状态", async () => {
    const picker = await import("../media/picker");
    const first = { uri: "file:first.jpg", name: "first.jpg", mimeType: "image/jpeg" };
    const second = { ...first, uri: "file:second.jpg", name: "second.jpg" };
    vi.spyOn(picker, "pickImages").mockResolvedValueOnce([first, second]);
    let finish!: (image: unknown) => void;
    let progress!: (fraction: number | null) => void;
    harness.uploadImage.mockImplementationOnce((_input, _avatar, callback) => {
      progress = callback;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    press(button(elements(NewLetterScreen()), "从相册添加图片"));
    await vi.waitFor(() => expect(harness.uploadImage).toHaveBeenCalledOnce());
    progress(0.37);
    rerender();
    let tree = elements(NewLetterScreen());
    const rings = tree.filter((node) => node.props.testID === "image-upload-progress");
    expect(rings).toHaveLength(2);
    expect(rings[0].props.accessibilityValue).toEqual({ min: 0, max: 100, now: 37 });
    expect(rings[1].props.accessibilityLabel).toBe("等待上传");
    expect(
      tree.filter((node) => node.type === "Image" && node.props.resizeMode === "cover")
    ).toHaveLength(2);
    expect(button(tree, "继续").props.disabled).toBe(true);
    progress(1);
    rerender();
    tree = elements(NewLetterScreen());
    expect(
      tree.find((node) => node.props.testID === "image-upload-progress")?.props.accessibilityLabel
    ).toBe("等待确认");
    expect(harness.state.get(0) ?? []).toEqual([]);
    finish({ id: "first-id", width: 100, height: 100 });
    await vi.waitFor(() => expect(harness.uploadImage).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.state.get(15)).toEqual([]));
    expect(harness.state.get(0)).toHaveLength(2);
  });
  it("生成预览时显示准备状态，准备完成前不冒充上传 0%", async () => {
    const picker = await import("../media/picker");
    const image = { uri: "file:photo.jpg", name: "photo.jpg", mimeType: "image/jpeg" };
    vi.spyOn(picker, "pickImages").mockResolvedValueOnce([image]);
    let finish!: (uri: string) => void;
    harness.preparePreview.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finish = resolve))
    );
    press(button(elements(NewLetterScreen()), "从相册添加图片"));
    await vi.waitFor(() => expect(harness.preparePreview).toHaveBeenCalledOnce());
    rerender();
    const tree = elements(NewLetterScreen());
    expect(
      tree.find((node) => node.props.testID === "image-upload-progress")?.props.accessibilityLabel
    ).toBe("准备中");
    expect(harness.uploadImage).not.toHaveBeenCalled();
    finish("data:image/jpeg;base64,anBlZw==");
    await vi.waitFor(() => expect(harness.state.get(15)).toEqual([]));
  });
  it("上传上一张时只提前准备下一张，不等整批压缩也不并发上传", async () => {
    const picker = await import("../media/picker");
    const images = ["first", "second", "third"].map((name) => ({
      uri: `file:${name}.jpg`,
      name: `${name}.jpg`,
      mimeType: "image/jpeg",
    }));
    vi.spyOn(picker, "pickImages").mockResolvedValueOnce(images);
    let finishPreparation!: (image: unknown) => void;
    harness.optimizeImage
      .mockResolvedValueOnce(images[0])
      .mockImplementationOnce(() => new Promise((resolve) => (finishPreparation = resolve)));
    let finishUpload!: (image: unknown) => void;
    harness.uploadImage.mockImplementationOnce(
      () => new Promise((resolve) => (finishUpload = resolve))
    );
    press(button(elements(NewLetterScreen()), "从相册添加图片"));
    await vi.waitFor(() => expect(harness.uploadImage).toHaveBeenCalledOnce());
    expect(harness.optimizeImage).toHaveBeenCalledTimes(2);
    expect(picker.pickImages).toHaveBeenCalledWith("album", 9, { prepare: false });
    rerender();
    const rings = elements(NewLetterScreen()).filter(
      (node) => node.props.testID === "image-upload-progress"
    );
    expect(rings.map((node) => node.props.accessibilityLabel)).toEqual([
      "连接中",
      "准备中",
      "等待上传",
    ]);
    finishUpload({ id: "first-id" });
    await vi.waitFor(() => expect(harness.state.get(0)).toHaveLength(1));
    expect(harness.uploadImage).toHaveBeenCalledOnce();
    expect(harness.optimizeImage).toHaveBeenCalledTimes(2);
    finishPreparation(images[1]);
    await vi.waitFor(() => expect(harness.state.get(15)).toEqual([]));
    expect(harness.uploadImage).toHaveBeenCalledTimes(3);
    expect(harness.optimizeImage).toHaveBeenCalledTimes(3);
  });
  it("提前准备失败不会丢弃其他图片，也不会上传未压缩的原图", async () => {
    const picker = await import("../media/picker");
    const { Alert } = await import("react-native");
    const images = ["first", "broken", "third"].map((name) => ({
      uri: `file:${name}.jpg`,
      name: `${name}.jpg`,
      mimeType: "image/jpeg",
    }));
    vi.spyOn(picker, "pickImages").mockResolvedValueOnce(images);
    harness.optimizeImage
      .mockResolvedValueOnce(images[0])
      .mockRejectedValueOnce(new Error("decode failed"));
    press(button(elements(NewLetterScreen()), "从相册添加图片"));
    await vi.waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith("部分图片未上传", expect.any(String))
    );
    expect(harness.uploadImage).toHaveBeenCalledTimes(2);
    expect(harness.uploadImage.mock.calls.map(([image]) => image.name)).toEqual([
      "first.jpg",
      "third.jpg",
    ]);
    expect(harness.state.get(0)).toHaveLength(2);
    expect(harness.state.get(15)).toEqual([
      expect.objectContaining({ input: images[1], phase: "failed" }),
    ]);
  });
  it("缩略图失败后重试复用已压缩文件，不重复降低 JPEG 质量", async () => {
    const picker = await import("../media/picker");
    const { Alert } = await import("react-native");
    const original = { uri: "file:original.jpg", name: "original.jpg", mimeType: "image/jpeg" };
    const compressed = { ...original, uri: "file:compressed.jpg" };
    vi.spyOn(picker, "pickImages").mockResolvedValueOnce([original]);
    harness.optimizeImage.mockResolvedValueOnce(compressed);
    harness.preparePreview.mockRejectedValueOnce(new Error("preview failed"));
    press(button(elements(NewLetterScreen()), "从相册添加图片"));
    await vi.waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith("图片未上传", expect.any(String))
    );
    expect(harness.uploadImage).not.toHaveBeenCalled();
    rerender();
    press(button(elements(NewLetterScreen()), "重试上传图片"));
    await vi.waitFor(() => expect(harness.state.get(15)).toEqual([]));
    expect(harness.optimizeImage).toHaveBeenCalledOnce();
    expect(harness.preparePreview).toHaveBeenCalledTimes(2);
    expect(harness.uploadImage).toHaveBeenCalledWith(compressed, false, expect.any(Function));
  });
  it("首张上传登录过期时，提前准备的下一张不会发起业务请求", async () => {
    const picker = await import("../media/picker");
    const { AuthExpiredError } = await import("../api/authenticatedFetch");
    const images = ["first", "second"].map((name) => ({
      uri: `file:${name}.jpg`,
      name: `${name}.jpg`,
      mimeType: "image/jpeg",
    }));
    vi.spyOn(picker, "pickImages").mockResolvedValueOnce(images);
    let finishPreparation!: (image: unknown) => void;
    harness.optimizeImage
      .mockResolvedValueOnce(images[0])
      .mockImplementationOnce(() => new Promise((resolve) => (finishPreparation = resolve)));
    harness.uploadImage.mockRejectedValueOnce(new AuthExpiredError());
    press(button(elements(NewLetterScreen()), "从相册添加图片"));
    await vi.waitFor(() => expect(harness.uploadImage).toHaveBeenCalledOnce());
    finishPreparation(images[1]);
    await vi.waitFor(() => expect(harness.navigate).toHaveBeenCalledWith("/"));
    expect(harness.uploadImage).toHaveBeenCalledOnce();
  });
  it("一张失败不丢弃其他图片，失败缩略图可重试", async () => {
    const picker = await import("../media/picker");
    const { Alert } = await import("react-native");
    const first = { uri: "file:first.jpg", name: "first.jpg", mimeType: "image/jpeg" };
    const second = { ...first, uri: "file:second.jpg", name: "second.jpg" };
    vi.spyOn(picker, "pickImages").mockResolvedValueOnce([first, second]);
    harness.uploadImage.mockRejectedValueOnce(new TypeError("Network unavailable"));
    press(button(elements(NewLetterScreen()), "从相册添加图片"));
    await vi.waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith("部分图片未上传", expect.any(String))
    );
    expect(harness.state.get(0)).toHaveLength(1);
    expect(harness.state.get(15)).toEqual([
      expect.objectContaining({ input: first, phase: "failed" }),
    ]);
    rerender();
    let tree = elements(NewLetterScreen());
    expect(button(tree, "继续").props.disabled).toBe(true);
    press(button(tree, "重试上传图片"));
    await vi.waitFor(() => expect(harness.state.get(15)).toEqual([]));
    expect(harness.state.get(0)).toHaveLength(2);
    expect(harness.optimizeImage).toHaveBeenCalledTimes(2);
    expect(harness.preparePreview).toHaveBeenCalledTimes(2);
    rerender();
    tree = elements(NewLetterScreen());
    expect(tree.some((node) => node.props.testID === "image-upload-progress")).toBe(false);
  });
  it("确认后可移除失败图片，不发送带有本地临时 ID 的删除请求", async () => {
    const { Alert } = await import("react-native");
    harness.state.set(15, [
      {
        id: "pending-local",
        input: { uri: "file:photo", name: "photo.jpg", mimeType: "image/jpeg" },
        localUri: "file:photo",
        phase: "failed",
        progress: 0.4,
      },
    ]);
    const tree = elements(NewLetterScreen());
    press(button(tree, "移除未上传图片"));
    vi.mocked(Alert.alert)
      .mock.calls.at(-1)?.[2]
      ?.find((action) => action.text === "移除")
      ?.onPress?.();
    await vi.waitFor(() => expect(harness.state.get(15)).toEqual([]));
    expect(harness.deleteImage).not.toHaveBeenCalled();
  });
  it("草稿缩略图可全屏预览，点击叉号后只有确认才删除", async () => {
    const { Alert } = await import("react-native");
    harness.state.set(0, [
      {
        id: "staged-image",
        localUri: "file:photo.png",
        url: "/api/v1/media/staged-image",
        mimeType: "image/png",
        width: 100,
        height: 100,
        byteSize: 200,
      },
    ]);
    let tree = elements(NewLetterScreen());
    const thumbnail = tree.find(
      (node) => node.type === "Image" && node.props.resizeMode === "cover"
    );
    expect(thumbnail?.props.style).toEqual({ width: "100%", height: "100%" });
    expect(button(tree, "预览信件图片").props.style).toEqual({
      width: "100%",
      height: "100%",
    });
    expect(thumbnail?.props.onError).toBeTypeOf("function");
    press(button(tree, "预览信件图片"));
    rerender();
    tree = elements(NewLetterScreen());
    expect(
      tree.some(
        (node) =>
          node.type === "Image" &&
          node.props.resizeMode === "contain" &&
          (node.props.source as { uri: string })?.uri === "file:photo.png"
      )
    ).toBe(true);
    expect(tree.some((node) => node.props.accessibilityLabel === "关闭图片预览")).toBe(false);
    const viewer = tree.find((node) => node.props.testID === "image-preview-viewport");
    (viewer?.props.onAccessibilityAction as (event: unknown) => void)({
      nativeEvent: { actionName: "dismiss" },
    });
    press(button(tree, "移除图片"));
    expect(Alert.alert).toHaveBeenCalledWith(
      "移除这张图片？",
      expect.any(String),
      expect.any(Array)
    );
    expect(harness.deleteImage).not.toHaveBeenCalled();
    const actions = vi.mocked(Alert.alert).mock.calls.at(-1)?.[2];
    expect(actions?.find((action) => action.text === "取消")?.style).toBe("cancel");
    actions?.find((action) => action.text === "移除")?.onPress?.();
    await vi.waitFor(() => expect(harness.deleteImage).toHaveBeenCalledWith("staged-image"));
    rerender();
    tree = elements(NewLetterScreen());
    expect(tree.some((node) => node.props.accessibilityLabel === "预览信件图片")).toBe(false);
  });
  it("草稿全屏按同一封信的缩略图顺序切换，切图不关闭预览", () => {
    harness.state.set(0, [
      { id: "one", localUri: "file:one", width: 100, height: 100 },
      { id: "two", localUri: "file:two", width: 200, height: 100 },
      { id: "three", localUri: "file:three", width: 100, height: 200 },
    ]);
    let tree = elements(NewLetterScreen());
    const thumbnails = tree.filter((node) => node.props.accessibilityLabel === "预览信件图片");
    press(thumbnails[1]);
    const currentImage = () => {
      rerender();
      tree = elements(NewLetterScreen());
      return tree.find((node) => node.type === "Image" && node.props.resizeMode === "contain");
    };
    expect(currentImage()?.props.source).toEqual({ uri: "file:two" });
    const changePage = (actionName: string) => {
      const viewer = tree.find((node) => node.props.testID === "image-preview-viewport");
      (viewer?.props.onAccessibilityAction as (event: unknown) => void)({
        nativeEvent: { actionName },
      });
    };
    changePage("increment");
    expect(currentImage()?.props.source).toEqual({ uri: "file:three" });
    changePage("increment");
    expect(currentImage()?.props.source).toEqual({ uri: "file:three" });
    changePage("decrement");
    expect(currentImage()?.props.source).toEqual({ uri: "file:two" });
  });
  it("已寄信件从选中的图片开始，只在本信图片内切换并支持重新打开", () => {
    const images = [
      { id: "one", width: 100, height: 100 },
      { id: "two", width: 200, height: 100 },
      { id: "three", width: 100, height: 200 },
    ] as NonNullable<LetterView["images"]>;
    let tree = elements(PrivateImages({ images }));
    press(tree.filter((node) => node.props.accessibilityLabel === "查看完整图片")[1]);
    const current = () => {
      rerender();
      tree = elements(PrivateImages({ images }));
      return tree.find((node) => node.props.fullscreen === true)?.props.id;
    };
    expect(current()).toBe("two");
    const action = (actionName: string) => {
      const viewer = tree.find((node) => node.props.testID === "image-preview-viewport");
      (viewer?.props.onAccessibilityAction as (event: unknown) => void)({
        nativeEvent: { actionName },
      });
    };
    action("increment");
    expect(current()).toBe("three");
    action("increment");
    expect(current()).toBe("three");
    action("decrement");
    expect(current()).toBe("two");
    action("decrement");
    expect(current()).toBe("one");
    action("dismiss");
    expect(current()).toBeUndefined();
    press(tree.filter((node) => node.props.accessibilityLabel === "查看完整图片")[1]);
    expect(current()).toBe("two");
  });
  it("整封信预加载完成后，全屏切换和重新打开直接复用像素，不再出现加载框", async () => {
    const cacheModule = await import("../media/privateImageCache");
    const images = [
      { id: "one", width: 100, height: 100 },
      { id: "two", width: 200, height: 100 },
      { id: "three", width: 100, height: 200 },
    ] as NonNullable<LetterView["images"]>;
    const loadImage = vi.fn(async (id: string) => `data:image/jpeg;base64,${id}`);
    const cache = cacheModule.createPrivateImageCache({
      ids: images.map((image) => image.id),
      loadImage,
      sameSession: () => true,
    });
    cache.preload();
    await vi.waitFor(() => expect(cache.read("three")?.status).toBe("ready"));
    const create = vi.spyOn(cacheModule, "createPrivateImageCache").mockReturnValue(cache);
    try {
      let tree = elements(PrivateImages({ images }));
      press(button(tree, "查看完整图片"));
      const current = () => {
        rerender();
        tree = elements(PrivateImages({ images }));
        const fullscreen = tree.find((node) => node.props.fullscreen === true);
        expect(tree.some((node) => node.type === "ActivityIndicator")).toBe(false);
        return fullscreen?.props.pixels;
      };
      expect(current()).toEqual({ status: "ready", data: "data:image/jpeg;base64,one" });
      const action = (actionName: string) => {
        const viewer = tree.find((node) => node.props.testID === "image-preview-viewport");
        (viewer?.props.onAccessibilityAction as (event: unknown) => void)({
          nativeEvent: { actionName },
        });
      };
      action("increment");
      expect(current()).toEqual({ status: "ready", data: "data:image/jpeg;base64,two" });
      action("increment");
      expect(current()).toEqual({ status: "ready", data: "data:image/jpeg;base64,three" });
      action("decrement");
      expect(current()).toEqual({ status: "ready", data: "data:image/jpeg;base64,two" });
      action("dismiss");
      current();
      press(button(tree, "查看完整图片"));
      expect(current()).toEqual({ status: "ready", data: "data:image/jpeg;base64,one" });
      expect(loadImage).toHaveBeenCalledTimes(3);
    } finally {
      create.mockRestore();
      cache.dispose();
    }
  });
  it("缩略图解码失败时弹窗提示，不静默留下空白", async () => {
    const { Alert } = await import("react-native");
    harness.state.set(0, [{ id: "staged-image", localUri: "file:broken" }]);
    const thumbnail = elements(NewLetterScreen()).find(
      (node) => node.type === "Image" && node.props.resizeMode === "cover"
    );
    (thumbnail?.props.onError as () => void)();
    expect(Alert.alert).toHaveBeenCalledWith("图片无法预览", expect.any(String));
  });
  it("确认收件人右侧显示固定尺寸头像，没有头像时显示昵称首字", () => {
    harness.state.set(3, {
      nickname: "收件人",
      account: "bobx",
      uid: "87654321",
      region: letter.target,
    });
    let tree = elements(NewLetterScreen());
    expect(
      tree.find((node) => node.props.testID === "recipient-avatar")?.props.style
    ).toMatchObject({ width: 48, height: 48, borderRadius: 24 });
    expect(text(tree)).toContain("收");
    harness.state.set(3, {
      nickname: "收件人",
      account: "bobx",
      uid: "87654321",
      region: letter.target,
      avatarUrl: "/api/v1/media/11111111-1111-4111-8111-111111111111",
    });
    rerender();
    tree = elements(NewLetterScreen());
    expect(text(tree)).not.toContain("收");
    expect(tree.some((node) => node.type === "ActivityIndicator")).toBe(true);
  });
  it("头像昵称编辑与地区编辑是两个独立表单", () => {
    harness.state.set(0, {
      nickname: "Alice",
      account: "alice",
      uid: "12345678",
      region: letter.origin,
    });
    harness.state.set(1, "Alice");
    harness.state.set(2, letter.origin);
    let tree = elements(ProfileScreen());
    expect(text(tree)).toContain("头像与昵称");
    expect(button(tree, "修改头像")).toBeDefined();
    expect(tree.some((node) => node.props.accessibilityLabel === "昵称")).toBe(true);
    expect(tree.some((node) => node.props.accessibilityLabel === "选择省")).toBe(false);
    harness.params = { section: "region" };
    rerender();
    tree = elements(ProfileScreen());
    expect(tree.some((node) => node.props.accessibilityLabel === "修改头像")).toBe(false);
    expect(tree.some((node) => node.props.accessibilityLabel === "昵称")).toBe(false);
    expect(button(tree, "选择省")).toBeDefined();
  });
  it("圆形头像裁剪提供拖动与缩放控制，上传前仍可取消", () => {
    const cancel = vi.fn();
    const tree = elements(
      AvatarCropper({
        image: {
          uri: "file:photo",
          width: 1200,
          height: 800,
          name: "avatar.jpg",
          mimeType: "image/jpeg",
        },
        onCancel: cancel,
        onConfirm: vi.fn(),
      })
    );
    const circle = tree.find((node) => node.props.testID === "avatar-crop-circle");
    expect(circle?.props.style).toContainEqual({ width: 342, height: 342, borderRadius: 171 });
    expect(harness.pan.onStartShouldSetPanResponder()).toBe(true);
    expect(button(tree, "缩小头像").props.disabled).toBe(true);
    press(button(tree, "放大头像"));
    rerender();
    const zoomed = elements(
      AvatarCropper({
        image: {
          uri: "file:photo",
          width: 1200,
          height: 800,
          name: "avatar.jpg",
          mimeType: "image/jpeg",
        },
        onCancel: cancel,
        onConfirm: vi.fn(),
      })
    );
    expect(text(zoomed)).toContain("1.2×");
    press(button(zoomed, "取消裁剪"));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([false, true])("头像上传失败=%s，仅失败弹窗，成功直接关闭裁剪", async (failed) => {
    const { Alert } = await import("react-native");
    const crop = await import("../media/avatarCrop");
    vi.spyOn(crop, "exportAvatar").mockResolvedValueOnce({
      uri: "file:cropped.jpg",
      name: "avatar.jpg",
      mimeType: "image/jpeg",
    });
    const cancel = vi.fn();
    const onConfirm = failed
      ? vi.fn().mockRejectedValue(new Error("network failed"))
      : vi.fn().mockResolvedValue(undefined);
    const tree = elements(
      AvatarCropper({
        image: {
          uri: "file:photo",
          width: 1200,
          height: 800,
          name: "photo.jpg",
          mimeType: "image/jpeg",
        },
        onCancel: cancel,
        onConfirm,
      })
    );
    press(button(tree, "使用头像"));
    await vi.waitFor(() => expect(harness.state.get(1)).toBe(false));
    expect(onConfirm).toHaveBeenCalledOnce();
    if (failed) {
      expect(Alert.alert).toHaveBeenCalledWith("头像未更新", expect.any(String));
      expect(cancel).not.toHaveBeenCalled();
    } else {
      expect(Alert.alert).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    }
  });
  it("图片操作失败直接弹窗提醒，不依赖页面下方错误框", async () => {
    const { getDocumentAsync } = await import("expo-document-picker");
    const { Alert } = await import("react-native");
    vi.mocked(getDocumentAsync).mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:missing", name: "photo.png", mimeType: "image/png", lastModified: 0 }],
    });
    const tree = elements(NewLetterScreen());
    press(button(tree, "从文件添加图片"));
    await vi.waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith("图片未上传", expect.any(String))
    );
  });
  it("我的页面保留账号与通知设置，长地区信息不被截断", () => {
    vi.stubGlobal("__DEV__", true);
    const region = { province: "内蒙古自治区", city: "呼伦贝尔市", district: "鄂温克族自治旗" };
    harness.polls = [{ nickname: "测试用户", account: "alice", uid: "12345678", region }];
    const tree = elements(MeScreen());
    expect(text(tree)).toEqual(
      expect.arrayContaining(["账号信息", "设置", "通知权限", "测试本地通知", "退出登录"])
    );
    const address = tree.find(
      (node) =>
        node.type === "Text" &&
        text([node]).includes(`${region.province} ${region.city} ${region.district}`)
    );
    expect(address).toBeDefined();
    expect(address?.props.numberOfLines).toBeUndefined();
    expect(button(tree, "打开系统通知设置").props.accessibilityRole).toBe("button");
    const rowStyle = (
      button(tree, "打开系统通知设置").props.style as (state: unknown) => unknown[]
    )({ pressed: false })[0];
    expect(rowStyle).toMatchObject({
      minHeight: 72,
    });
    expect(rowStyle).not.toHaveProperty("borderRadius");
    expect(rowStyle).not.toHaveProperty("borderBottomWidth");
    const groups = tree.filter((node) => String(node.props.testID).endsWith("settings-group"));
    expect(groups).toHaveLength(2);
    for (const group of groups)
      expect(group.props.style).toMatchObject({
        borderRadius: UI.radius,
        borderCurve: "continuous",
        backgroundColor: C.surface,
        overflow: "hidden",
      });
    expect(
      tree.filter((node) => (node.props.style as { height?: number })?.height === 0.5)
    ).toHaveLength(5);
    expect(text(tree)).not.toContain("个人资料");
    press(button(tree, "修改头像和昵称"));
    expect(harness.navigate).toHaveBeenLastCalledWith("/profile");
    press(button(tree, "修改所在地区"));
    expect(harness.navigate).toHaveBeenLastCalledWith({
      pathname: "/profile",
      params: { section: "region" },
    });
    expect(button(tree, "检查底栏材质").props.accessibilityRole).toBe("button");
    vi.unstubAllGlobals();
  });
  it("寄信仍是独立加号按钮，查件和我的才是底部标签", () => {
    const tree = elements(BottomNav({ active: "letters" }));
    expect(
      tree.find((node) => node.props.pointerEvents === "box-none")?.props.style
    ).toContainEqual({ bottom: 34 });
    expect(
      tree
        .filter((node) => node.props.accessibilityRole === "tab")
        .map((node) => node.props.accessibilityLabel)
    ).toEqual(["查件", "我的"]);
    const compose = button(tree, "写信");
    expect(compose.props.accessibilityRole).toBe("button");
    press(compose);
    expect(harness.navigate).toHaveBeenCalledWith("/letters/new");
  });

  it("底栏水平拖动切换标签，取消、纵向移动与加号不触发切换", () => {
    let tree = elements(BottomNav({ active: "letters" }));
    const begin = button(tree, "查件").props.onPressIn as () => void;
    begin();
    expect(harness.pan.onMoveShouldSetPanResponder(null, { dx: 3, dy: 0 })).toBe(false);
    expect(harness.pan.onMoveShouldSetPanResponder(null, { dx: 8, dy: 20 })).toBe(false);
    expect(harness.pan.onMoveShouldSetPanResponder(null, { dx: 90, dy: 0 })).toBe(true);
    harness.pan.onPanResponderGrant();
    harness.pan.onPanResponderMove(null, { dx: 200, dy: 0 });
    harness.pan.onPanResponderRelease();
    expect(harness.navigate).toHaveBeenCalledWith("/me");
    harness.navigate.mockClear();
    begin();
    harness.pan.onPanResponderGrant();
    harness.pan.onPanResponderMove(null, { dx: 200, dy: 0 });
    harness.pan.onPanResponderTerminate();
    expect(harness.navigate).not.toHaveBeenCalled();
    tree = elements(BottomNav({ active: "me" }));
    (button(tree, "写信").props.onPressIn as () => void)();
    expect(harness.pan.onMoveShouldSetPanResponder(null, { dx: -200, dy: 0 })).toBe(false);
  });

  it("列表保留搜索和筛选，联系人与运输状态先于城市和时间", () => {
    harness.polls = [{ sent: [letter], received: [] }];
    const tree = elements(LettersScreen());
    expect(text(tree)).toEqual(
      expect.arrayContaining(["驿书", "我的信件", "全部", "我收到的", "我寄出的"])
    );
    expect(tree.some((node) => node.props.accessibilityLabel === "搜索信件")).toBe(true);
    const list = tree.find((node) => node.type === "FlatList");
    const renderItem = list?.props.renderItem as (props: unknown) => ReactNode;
    const row = elements(renderItem({ item: { letter, direction: "sent" } }));
    expect(text(row).slice(0, 3)).toEqual(["收件人", "寄给", "运输中"]);
    press(button(row, "收件人，运输中"));
    expect(harness.navigate).toHaveBeenCalledWith("/letters/YS-TEST");
  });

  it.each(["sent", "received"])("%s 卡片保持市级展示，不显示区县", (direction) => {
    const sameCity = {
      ...letter,
      origin: { province: "上海市", city: "上海市", district: "黄浦区" },
      target: { province: "上海市", city: "上海市", district: "浦东新区" },
    };
    const list = elements(LettersScreen()).find((node) => node.type === "FlatList");
    const render = list!.props.renderItem as (props: unknown) => ReactNode;
    const row = elements(render({ item: { letter: sameCity, direction } }));
    expect(text(row).filter((value) => value === "上海市")).toHaveLength(2);
    expect(text(row).join("")).not.toContain("黄浦区");
    expect(text(row).join("")).not.toContain("浦东新区");
  });
  it.each(["sent", "received"])("%s 首页卡片不显示寄送方式，保留时间与详情入口", (direction) => {
    const list = elements(LettersScreen()).find((node) => node.type === "FlatList");
    const render = list!.props.renderItem as (props: unknown) => ReactNode;
    const row = elements(render({ item: { letter, direction } }));
    expect(text(row)).toContain(formatFactTime(letter.createdAt));
    expect(text(row).join("")).not.toMatch(/寄送方式|驿马|托人捎信|加急驿递|飞鸽传书/);
    press(button(row, `${direction === "sent" ? "收件人" : "寄件人"}，运输中`));
    expect(harness.navigate).toHaveBeenCalledWith("/letters/YS-TEST");
  });
  it("信件首页只有最新动态入口、正文和寄收信息，不重复展示地图或计划", () => {
    harness.polls = [{ letter, timeline: facts }];
    const tree = elements(LetterDetailScreen());
    expect(text(tree)).toEqual(
      expect.arrayContaining(["信件内容", letter.content, "寄收信息", "动态 5"])
    );
    expect(text(tree)).not.toContain("动态 4");
    expect(tree.some((node) => node.type === "InteractiveRouteMap")).toBe(false);
    expect(text(tree)).not.toContain("计划路段");
    press(button(tree, "查看物流详情"));
    expect(harness.navigate).toHaveBeenCalledWith("/letters/YS-TEST/logistics");
  });

  it("收件人在送达并拆阅前看不到正文", () => {
    harness.polls = [{ letter: { ...letter, readState: "UNOPENED" }, timeline: facts }];
    const tree = elements(LetterDetailScreen());
    expect(text(tree)).not.toContain(letter.content);
    expect(text(tree)).toContain("送达后可以查看");
  });

  it("图片与写信时间保持正文的同一拆阅门禁", () => {
    const image = {
      id: "11111111-1111-4111-8111-111111111111",
      url: "/api/v1/media/11111111-1111-4111-8111-111111111111",
      width: 24,
      height: 16,
      mimeType: "image/png",
      byteSize: 100,
    };
    harness.polls = [
      {
        letter: {
          ...letter,
          status: "DELIVERED",
          readState: "UNOPENED",
          writtenAt: "2026-10-03T08:00:00.000Z",
          images: [image],
        },
        timeline: facts,
      },
    ];
    let tree = elements(LetterDetailScreen());
    expect(tree.some((node) => node.props.accessibilityLabel === "查看完整图片")).toBe(false);
    expect(text(tree).some((value) => value.startsWith("写于"))).toBe(false);
    rerender();
    harness.polls = [
      {
        letter: {
          ...letter,
          status: "DELIVERED",
          readState: "OPENED",
          writtenAt: "2026-10-03T08:00:00.000Z",
          images: [image],
        },
        timeline: facts,
      },
    ];
    tree = elements(LetterDetailScreen());
    expect(tree.some((node) => node.props.accessibilityLabel === "查看完整图片")).toBe(true);
    expect(text(tree).some((value) => value.startsWith("写于"))).toBe(true);
    expect(text(tree)).toContain(letter.content);
    expect(tree.some((node) => node.type === "ReadLetterRitual")).toBe(false);
  });

  it("物流默认显示最新三条，展开后显示全部，收起后恢复三条", () => {
    harness.polls = [{ letter, timeline: facts }, map];
    let tree = elements(LogisticsScreen());
    expect(text(tree).filter((value) => /^动态 /.test(value))).toEqual([
      "动态 5",
      "动态 4",
      "动态 3",
    ]);
    press(button(tree, "查看全部运输动态"));
    rerender();
    tree = elements(LogisticsScreen());
    expect(text(tree).filter((value) => /^动态 /.test(value))).toHaveLength(6);
    expect(button(tree, "收起运输动态").props.accessibilityState).toEqual({ expanded: true });
    press(button(tree, "收起运输动态"));
    rerender();
    tree = elements(LogisticsScreen());
    expect(text(tree).filter((value) => /^动态 /.test(value))).toHaveLength(3);
  });

  it("收件人的净化地图没有计划图例，也不能重试建立路线", () => {
    harness.polls = [
      { letter: { ...letter, status: "CREATED", readState: "UNOPENED" }, timeline: [] },
      map,
    ];
    const tree = elements(LogisticsScreen());
    expect(tree.some((node) => node.type === "InteractiveRouteMap")).toBe(true);
    expect(text(tree)).not.toContain("计划路段");
    expect(tree.some((node) => node.props.accessibilityLabel === "重试建立路线")).toBe(false);
  });

  it("寄件人仍可查看计划路段", () => {
    harness.polls = [
      { letter, timeline: facts },
      {
        ...map,
        remainingPath: [
          { x: 800, y: 200 },
          { x: 900, y: 250 },
        ],
      },
    ];
    expect(text(elements(LogisticsScreen()))).toContain("计划路段");
  });

  it("地图触摸立即切换原生页面滚动并保持 React 状态一致", () => {
    harness.polls = [{ letter, timeline: facts }, map];
    const tree = elements(LogisticsScreen());
    const scroll = tree.find((node) => node.type === "ScrollView")!;
    const setNativeProps = vi.fn();
    (scroll.props.ref as { current: unknown }).current = { setNativeProps };
    const changed = tree.find((node) => node.type === "InteractiveRouteMap")!.props
      .onInteractionChange as (active: boolean) => void;
    expect(scroll.props.scrollEnabled).toBe(true);
    changed(true);
    expect(setNativeProps).toHaveBeenLastCalledWith({ scrollEnabled: false });
    rerender();
    expect(
      elements(LogisticsScreen()).find((node) => node.type === "ScrollView")?.props.scrollEnabled
    ).toBe(false);
    changed(false);
    expect(setNativeProps).toHaveBeenLastCalledWith({ scrollEnabled: true });
    rerender();
    expect(
      elements(LogisticsScreen()).find((node) => node.type === "ScrollView")?.props.scrollEnabled
    ).toBe(true);
  });

  it("写信保留四种寄送方式、正文计数，并避让 iPhone 键盘", () => {
    const tree = elements(NewLetterScreen());
    expect(tree.filter((node) => node.props.accessibilityRole === "radio")).toHaveLength(4);
    expect(tree.find((node) => node.type === "KeyboardAvoidingView")?.props.behavior).toBe(
      "padding"
    );
    expect(
      tree.find((node) => node.type === "KeyboardAvoidingView")?.props.keyboardVerticalOffset
    ).toBe(59);
    expect(button(tree, "继续").props.disabled).toBe(true);
    expect(text(tree)).toContain("0 / 2000");
  });

  it("登录注册、资料与信件搜索使用原生 iOS 键盘边距，不重复避让", () => {
    harness.state.set(0, false);
    const home = elements(HomeScreen());
    harness.state.clear();
    rerender();
    const pages = [home, elements(ProfileScreen())];
    rerender();
    pages.push(elements(LettersScreen()));
    for (const tree of pages) {
      const frame = tree.find((node) => node.type === "KeyboardAvoidingView");
      expect(frame?.props.enabled).toBe(false);
      expect(frame?.props.keyboardVerticalOffset).toBe(59);
      const scroll = tree.find((node) => node.type === "ScrollView" || node.type === "FlatList");
      expect(scroll?.props.automaticallyAdjustKeyboardInsets).toBe(true);
      expect(scroll?.props.keyboardShouldPersistTaps).toBe("handled");
      expect(scroll?.props.keyboardDismissMode).toBe("on-drag");
    }
  });

  it("加密页固定顶栏，输入框随键盘缩小后的真实视口滚动", () => {
    harness.state.set(0, { enabled: true, available: true });
    harness.params.uid = "23456789";
    const tree = elements(EncryptionScreen());
    const frame = tree.find((node) => node.type === "KeyboardAvoidingView");
    const scroll = tree.find((node) => node.type === "ScrollView");
    const input = tree.find((node) => node.props.accessibilityLabel === "联系人用户编号");
    if (!scroll || !input || !frame) throw new Error("Missing encryption keyboard layout");
    expect(frame.props.enabled).toBe(true);
    expect(frame.props.keyboardVerticalOffset).toBe(59);
    expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(false);
    expect(scroll.props.contentInsetAdjustmentBehavior).toBe("never");
    expect(text(elements(frame.props.children))).not.toContain("端到端加密");
    expect(text(tree)).toContain("端到端加密");
    const scrollTo = vi.fn();
    const viewport = tree.find((node) => node.type === "View" && node.props.collapsable === false);
    if (!viewport) throw new Error("Missing keyboard viewport");
    let viewportHeight = 700;
    let inputTop = 650;
    (viewport.props.ref as { current: unknown }).current = {
      measureInWindow: (callback: (...values: number[]) => void) =>
        callback(0, 123, 390, viewportHeight),
    };
    (scroll.props.ref as { current: unknown }).current = { scrollTo };
    (input.props.ref as { current: unknown }).current = {
      isFocused: () => true,
      measureInWindow: (callback: (...values: number[]) => void) => callback(0, inputTop, 350, 56),
    };
    (input.props.onFocus as (event: unknown) => void)({});
    expect(scrollTo).not.toHaveBeenCalled();
    (scroll.props.onScroll as (event: unknown) => void)({
      nativeEvent: { contentOffset: { y: 40 } },
    });
    viewportHeight = 300;
    (scroll.props.onLayout as () => void)();
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 339, animated: true });
    scrollTo.mockClear();
    inputTop = 350;
    (viewport.props.onLayout as () => void)();
    expect(scrollTo).not.toHaveBeenCalled();
    (input.props.onBlur as (event: unknown) => void)({});
    inputTop = 650;
    (viewport.props.onLayout as () => void)();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("加密设置默认没有开启、恢复码确认或联系人安全码的必填步骤", () => {
    harness.state.set(0, { enabled: true, available: true, backupAvailable: true });
    const tree = elements(EncryptionScreen());
    expect(tree.filter((node) => node.type === "TextInput")).toHaveLength(0);
    expect(text(tree)).not.toContain("开启加密");
    expect(button(tree, "备份恢复码（可选）")).toBeDefined();
    (button(tree, "核验联系人（可选）").props.onPress as () => void)();
    rerender();
    expect(elements(EncryptionScreen()).filter((node) => node.type === "TextInput")).toHaveLength(
      2
    );
  });
  it("原密钥可用的旧手动账号可以选填原恢复码保存备份", async () => {
    harness.state.set(0, { enabled: true, available: true, backupAvailable: false });
    const tree = elements(EncryptionScreen());
    expect(tree.filter((node) => node.type === "TextInput")).toHaveLength(0);
    (button(tree, "保存原恢复码（可选）").props.onPress as () => void)();
    await Promise.resolve();
    rerender();
    const imported = elements(EncryptionScreen());
    expect(imported.some((node) => node.props.accessibilityLabel === "恢复码")).toBe(true);
    expect(button(imported, "保存原恢复码").props.disabled).toBe(true);
    expect(harness.encryptionPrepare).not.toHaveBeenCalled();
    expect(harness.encryptionActivate).not.toHaveBeenCalled();
  });

  it("地区搜索弹窗以全屏坐标避让键盘，并允许收缩选项列表", () => {
    harness.state.set(0, "province");
    const tree = elements(
      RegionSelector({
        value: { province: "", city: "", district: "" },
        onChange: vi.fn(),
      })
    );
    const frame = tree.find((node) => node.type === "KeyboardAvoidingView");
    expect(frame?.props.enabled).toBe(true);
    expect(frame?.props.keyboardVerticalOffset).toBe(0);
    expect(tree.some((node) => node.props.accessibilityLabel === "搜索地区")).toBe(true);
    expect(tree.find((node) => node.type === "FlatList")?.props.style).toMatchObject({
      flexShrink: 1,
      minHeight: 0,
    });
  });

  it.each([
    {
      level: "province",
      value: { province: "", city: "", district: "" },
      item: { code: "81", name: "香港特别行政区" },
    },
    {
      level: "district",
      value: { province: "福建省", city: "泉州市", district: "" },
      item: { code: "350527", name: "金门县" },
    },
    {
      level: "district",
      value: { province: "海南省", city: "三沙市", district: "" },
      item: { code: "460303", name: "南沙区" },
    },
    {
      level: "district",
      value: { province: "海南省", city: "三沙市", district: "" },
      item: { code: "460322", name: "南沙群岛" },
    },
  ])(
    "unavailable $item.name is labelled and opens a popup without changing the region",
    async ({ level, value, item }) => {
      const { Alert } = await import("react-native");
      const onChange = vi.fn();
      harness.state.set(0, level);
      const tree = elements(RegionSelector({ value, onChange }));
      const list = tree.find((node) => node.type === "FlatList");
      if (!list) throw new Error("Missing region list");
      const renderItem = list.props.renderItem as (args: { item: typeof item }) => ReactNode;
      const row = elements(renderItem({ item }));
      expect(text(row)).toContain("暂未开通服务");
      const option = row.find((node) => node.type === "Pressable");
      if (!option) throw new Error("Missing region option");
      press(option);
      expect(Alert.alert).toHaveBeenCalledWith(
        "暂未开通服务",
        "该地区暂未开通服务，请选择已开通地区。"
      );
      expect(onChange).not.toHaveBeenCalled();
    }
  );

  it("安卓键盘框使用高度避让，原生 iOS 模式不会禁用安卓避让", async () => {
    const { Platform } = await import("react-native");
    const original = Platform.OS;
    try {
      Platform.OS = "android";
      const frame = elements(KeyboardFrame({ nativeInsets: true })).find(
        (node) => node.type === "KeyboardAvoidingView"
      );
      expect(frame?.props.enabled).toBe(true);
      expect(frame?.props.behavior).toBe("height");
      expect(frame?.props.keyboardVerticalOffset).toBe(59);
    } finally {
      Platform.OS = original;
    }
  });

  it("正文聚焦和键盘压缩视口时滚入可见区域，失焦后不抢滚动", () => {
    const tree = elements(NewLetterScreen());
    const scroll = tree.find((node) => node.type === "ScrollView");
    const body = tree.find((node) => node.props.accessibilityLabel === "信件正文");
    if (!scroll || !body) throw new Error("Missing composer editor");
    const wrapper = tree.find(
      (node) =>
        node.type === "View" && node.props.onLayout && elements(node.props.children).includes(body)
    );
    if (!wrapper) throw new Error("Missing composer keyboard layout");
    const scrollTo = vi.fn();
    (scroll.props.ref as { current: unknown }).current = { scrollTo };
    const layout = (node: Element, height: number, y = 0) =>
      (node.props.onLayout as (event: LayoutChangeEvent) => void)({
        nativeEvent: { layout: { x: 0, y, width: 390, height } },
      } as LayoutChangeEvent);
    layout(wrapper, 220, 340);
    expect(scrollTo).not.toHaveBeenCalled();
    (body.props.onFocus as () => void)();
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 324, animated: true });
    layout(scroll, 200);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 324, animated: false });
    expect(body.props.scrollEnabled).toBe(true);
    rerender();
    const resized = elements(NewLetterScreen()).find(
      (node) => node.props.accessibilityLabel === "信件正文"
    );
    if (!resized) throw new Error("Missing resized editor");
    expect(resized.props.style).toContainEqual({ height: 168 });
    (body.props.onBlur as () => void)();
    scrollTo.mockClear();
    layout(scroll, 700);
    expect(scrollTo).not.toHaveBeenCalled();
    rerender();
    expect(
      elements(NewLetterScreen()).find((node) => node.props.accessibilityLabel === "信件正文")
        ?.props.style
    ).toContainEqual({ height: 220 });
  });

  it("寄送方式切换时同步介绍和实际寄收地区的参考时长", () => {
    harness.state.set(3, {
      uid: "87654321",
      nickname: "收件人",
      account: "bobx",
      region: letter.target,
    });
    harness.state.set(10, [{ transportType: "PIGEON", distanceKm: 1000, durationSeconds: 21600 }]);
    harness.state.set(6, "PIGEON");
    const tree = elements(NewLetterScreen());
    expect(text(tree).join(" ")).toContain("点对点飞行");
    expect(text(tree).join(" ")).toContain("约 6 小时");
  });

  it("下一站预估只传给寄件人的地图，收件人即使收到预估也不展示", () => {
    const estimate = { state: "ON_THE_WAY", remainingSeconds: 3600 };
    harness.polls = [{ letter, timeline: facts, estimate }, map];
    expect(
      elements(LogisticsScreen()).find((node) => node.type === "InteractiveRouteMap")?.props
        .progress
    ).toEqual({ title: "在路上", detail: "预计还有 1 小时 到下一站" });
    rerender();
    harness.polls = [
      { letter: { ...letter, readState: "UNOPENED" }, timeline: facts, estimate },
      map,
    ];
    expect(
      elements(LogisticsScreen()).find((node) => node.type === "InteractiveRouteMap")?.props
        .progress
    ).toBeUndefined();
  });

  it("登录与注册是可访问的分段控件，切换注册保留地区输入", () => {
    harness.state.set(0, false);
    let tree = elements(HomeScreen());
    const register = tree.find(
      (node) => node.type === "Pressable" && text(elements(node as ReactNode)).includes("注册")
    );
    if (!register) throw new Error("Missing register tab");
    expect(register.props.accessibilityRole).toBe("tab");
    press(register);
    rerender();
    tree = elements(HomeScreen());
    for (const label of ["账号", "密码", "昵称"]) {
      expect(
        tree.some((node) => node.type === "TextInput" && node.props.accessibilityLabel === label)
      ).toBe(true);
    }
    for (const label of ["选择省", "选择市", "选择区县"]) {
      expect(button(tree, label).props.accessibilityRole).toBe("button");
    }
  });
});

describe("共用控件", () => {
  it("圆形进度只显示真实比例，等待响应或总量未知时不冒充上传完成", () => {
    const ring = (progress: number | null) =>
      elements(UploadProgressRing({ phase: "uploading", progress }));
    expect(ring(0.999)[0].props.accessibilityValue).toEqual({ min: 0, max: 100, now: 99 });
    expect(text(ring(1))).toContain("等待确认");
    expect(text(ring(1))).not.toContain("100%");
    expect(ring(null).some((node) => node.type === "ActivityIndicator")).toBe(true);
    expect(text(ring(0))).toContain("连接中");
    expect(text(ring(0))).not.toContain("0%");
    expect(ring(0).some((node) => node.type === "ActivityIndicator")).toBe(true);
  });
  it("支持原生玻璃、旧 iOS 模糊和降低透明度回退", () => {
    expect(glassMaterial("ios", true, false)).toBe("glass");
    expect(glassMaterial("ios", false, false)).toBe("blur");
    expect(glassMaterial("ios", true, true)).toBe("opaque");
    expect(glassMaterial("android", false, false)).toBe("opaque");
    harness.state.set(0, false);
    harness.state.set(1, { width: 350, height: 72 });
    const tree = elements(GlassSurface({ children: "content", style: { borderRadius: 36 } }));
    const native = tree.find((node) => node.type === "GlassView");
    expect(native).toBeDefined();
    expect(native?.props.style).toContainEqual({ width: 350, height: 72 });
    expect(native?.props.pointerEvents).toBe("none");
    expect(tree[0].props.collapsable).toBe(false);
    expect((native?.props.style as unknown[]).flat(Infinity)).toContainEqual(
      expect.objectContaining({ position: "absolute", top: 0, left: 0 })
    );
  });

  it("玻璃等待尺寸确定后挂载，布局不能把原生层当成导航栏子按钮", () => {
    harness.state.set(0, false);
    let tree = elements(GlassSurface({ children: "content", style: { borderRadius: 36 } }));
    expect(tree.some((node) => node.type === "GlassView")).toBe(false);
    (tree[0].props.onLayout as (event: unknown) => void)({
      nativeEvent: { layout: { width: 350, height: 72 } },
    });
    rerender();
    tree = elements(GlassSurface({ children: "content", style: { borderRadius: 36 } }));
    expect(tree.some((node) => node.type === "GlassView")).toBe(true);
  });

  it("拖动材质使用 clear 原生玻璃，松手材质使用普通磨砂", () => {
    harness.state.set(0, false);
    harness.state.set(1, { width: 120, height: 56 });
    const clear = elements(
      GlassSurface({ children: null, style: { borderRadius: 28 }, appearance: "clear" })
    );
    expect(clear.find((node) => node.type === "GlassView")?.props.glassEffectStyle).toBe("clear");
    rerender();
    const frosted = elements(
      GlassSurface({ children: null, style: { borderRadius: 28 }, appearance: "frosted" })
    );
    expect(frosted.some((node) => node.type === "GlassView")).toBe(false);
    expect(frosted.find((node) => node.type === "BlurView")?.props.intensity).toBe(80);
  });
  it("诊断报告记录运行时支持性，不把选中材质说成视觉验收通过", async () => {
    const { AccessibilityInfo } = await import("react-native");
    vi.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockResolvedValue(false);
    expect(await getGlassDiagnostics()).toContain("选择的材质：原生 Liquid Glass");
    vi.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockResolvedValue(true);
    expect(await getGlassDiagnostics()).toContain("选择的材质：实色回退");
  });

  it("列表与我的页面给悬浮底栏留出可滚动空间", () => {
    vi.stubGlobal("__DEV__", false);
    harness.polls = [{ sent: [], received: [] }];
    expect(
      elements(LettersScreen()).find((node) => node.type === "FlatList")?.props
        .contentContainerStyle
    ).toContainEqual({ paddingBottom: UI.bottomNavHeight + 34 + 24 });
    rerender();
    harness.polls = [null];
    expect(
      elements(MeScreen()).find((node) => node.type === "ScrollView")?.props.contentContainerStyle
    ).toContainEqual({ paddingBottom: UI.bottomNavHeight + 34 + 24 });
    vi.unstubAllGlobals();
  });
  it("标题居中，两侧占位相同且返回按钮触控区域不小于 44", () => {
    const tree = elements(
      ScreenHeader({ title: "物流详情", backLabel: "返回", onBack: harness.navigate })
    );
    const back = button(tree, "返回");
    const style = (back.props.style as (state: unknown) => unknown[])({ pressed: false })[0] as {
      width: number;
      height: number;
    };
    expect(style.width).toBe(44);
    expect(style.height).toBe(44);
    press(back);
    expect(harness.navigate).toHaveBeenCalled();
  });

  it("主按钮保留禁用语义和稳定高度", () => {
    const tree = elements(ActionButton({ title: "寄出", onPress: vi.fn(), disabled: true }));
    const action = button(tree, "寄出");
    expect(action.props.accessibilityState).toEqual({ disabled: true });
    const style = (action.props.style as (state: unknown) => unknown[])({ pressed: false })[0] as {
      minHeight: number;
    };
    expect(style.minHeight).toBe(UI.controlHeight);
    expect(style).toMatchObject({ borderRadius: 26, borderCurve: "continuous", shadowRadius: 10 });
  });

  it("寄信仪式在请求和路线完成前不导航，封口完成后只导航一次", async () => {
    harness.persistentRefs = true;
    harness.state.set(3, { uid: "87654321", nickname: "收件人", region: letter.target });
    harness.state.set(5, "测试信纸");
    harness.state.set(7, true);
    let created!: (value: { trackingNo: string }) => void;
    let routed!: () => void;
    harness.createLetter.mockImplementation(() => new Promise((done) => { created = done; }));
    harness.initializeJourney.mockImplementation(() => new Promise<void>((done) => { routed = done; }));
    let tree = elements(NewLetterScreen());
    const send = button(tree, "确认发送");
    press(send); press(send);
    expect(harness.createLetter).toHaveBeenCalledTimes(1);
    created({ trackingNo: "YS-NEW" }); await Promise.resolve(); await Promise.resolve();
    expect(harness.initializeJourney).toHaveBeenCalledWith("YS-NEW");
    expect(harness.navigate).not.toHaveBeenCalled();
    rerender(); tree = elements(NewLetterScreen());
    expect(tree.find((node) => node.type === "SendLetterRitual")?.props.ready).toBe(false);
    routed(); await Promise.resolve(); await Promise.resolve();
    rerender(); tree = elements(NewLetterScreen());
    const ritual = tree.find((node) => node.type === "SendLetterRitual")!;
    expect(ritual.props.ready).toBe(true);
    (ritual.props.onComplete as () => void)(); (ritual.props.onComplete as () => void)();
    expect(harness.navigate).toHaveBeenCalledTimes(1);
    expect(harness.navigate).toHaveBeenCalledWith("/letters/YS-NEW");
  });

  it("寄信仪式路线失败保留信件编号和草稿，重试不重复创建", async () => {
    harness.persistentRefs = true;
    harness.state.set(3, { uid: "87654321", nickname: "收件人", region: letter.target });
    harness.state.set(5, "原来的草稿");
    harness.state.set(7, true);
    harness.createLetter.mockResolvedValue({ trackingNo: "YS-SAVED" });
    harness.initializeJourney.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    press(button(elements(NewLetterScreen()), "确认发送"));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(harness.state.get(9)).toBe("YS-SAVED");
    expect(harness.state.get(5)).toBe("原来的草稿");
    expect(harness.state.get(17)).toBeNull();
    expect(harness.navigate).not.toHaveBeenCalled();
    rerender();
    const tree = elements(NewLetterScreen());
    const retry = tree.find((node) => node.type === "Pressable" && String(node.props.accessibilityLabel).includes("重试"));
    expect(retry).toBeDefined(); press(retry!);
    await Promise.resolve(); await Promise.resolve();
    expect(harness.createLetter).toHaveBeenCalledTimes(1);
    expect(harness.initializeJourney).toHaveBeenCalledTimes(2);
  });

  it("查找自己时弹窗提醒，不保留收件人且不能寄出", async () => {
    const { Alert } = await import("react-native");
    harness.state.set(2, "12345678");
    harness.state.set(3, { uid: "87654321", nickname: "原收件人", region: letter.target });
    harness.searchRecipient.mockResolvedValue({ uid: "12345678" });
    harness.getCurrentUser.mockResolvedValue({ uid: "12345678" });
    const tree = elements(NewLetterScreen());
    const find = tree.find((node) => node.type === "Pressable" && node.props.accessibilityLabel === "搜索收件人")!;
    press(find);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(Alert.alert).toHaveBeenCalledWith("不能给自己寄信", "请选择其他收件人。");
    expect(harness.state.get(3)).toBeNull();
    expect(harness.createLetter).not.toHaveBeenCalled();
  });

  it.each([
    ["HAND_CARRY", "托人捎信"],
    ["HORSE_RELAY", "驿马"],
    ["EXPRESS_RELAY", "加急驿递"],
    ["PIGEON", "飞鸽传书"],
  ] as const)("寄收信息显示原始寄送方式 %s，不影响未拆阅内容门禁", (initialTransport, label) => {
    harness.polls = [{ letter: { ...letter, initialTransport, currentTransport: "PIGEON", readState: "UNOPENED" }, timeline: facts }];
    const tree = elements(LetterDetailScreen());
    const row = tree.find((node) => node.type === "View" && text(elements(node.props.children as ReactNode))[0] === "寄送方式");
    expect(text(elements(row?.props.children as ReactNode))).toEqual(["寄送方式", label]);
    expect(text(tree)).not.toContain(letter.content);
  });

  it("拆开按钮只进入仪式，点击骑缝章才调用拆阅接口", async () => {
    harness.polls = [{ letter: { ...letter, status: "DELIVERED", readState: "UNOPENED" }, timeline: facts }];
    harness.openLetter.mockResolvedValue(undefined);
    harness.getLetter.mockResolvedValue({ ...letter, status: "DELIVERED", readState: "OPENED" });
    let tree = elements(LetterDetailScreen());
    press(button(tree, "拆开"));
    expect(harness.openLetter).not.toHaveBeenCalled();
    rerender(); tree = elements(LetterDetailScreen());
    const reader = tree.find((node) => node.type === "ReadLetterRitual")!;
    await (reader.props.onOpen as () => Promise<unknown>)();
    expect(harness.openLetter).toHaveBeenCalledWith("YS-TEST");
    expect(harness.getLetter).toHaveBeenCalledWith("YS-TEST");
    (reader.props.onComplete as (letter: LetterView) => void)({ ...letter, status: "DELIVERED", readState: "OPENED" });
    rerender();
    expect(elements(LetterDetailScreen()).some((node) => node.type === "ReadLetterRitual")).toBe(false);
    rerender();
    expect(text(elements(LetterDetailScreen()))).toContain(letter.content);
  });

  it("输入框聚焦显示绿色边框，且不改变尺寸", () => {
    let tree = elements(FormInput({ accessibilityLabel: "账号" }));
    const input = tree.find((node) => node.type === "TextInput");
    (input?.props.onFocus as (event: unknown) => void)({});
    rerender();
    tree = elements(FormInput({ accessibilityLabel: "账号" }));
    const focused = tree.find((node) => node.type === "TextInput");
    expect(focused?.props.style).toContainEqual({ borderColor: C.green });
    expect((focused?.props.style as unknown[])[0]).toMatchObject({ minHeight: UI.controlHeight });
  });
});

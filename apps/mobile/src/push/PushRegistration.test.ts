import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  cleanups: [] as (() => void)[],
  granted: true,
  authenticated: true,
  retained: null as string | null,
  register: vi.fn(),
  push: vi.fn(),
  refetch: vi.fn(),
  remove: vi.fn(),
  token: vi.fn(),
  tapped: null as null | ((response: unknown) => void),
  received: null as null | (() => void),
  cold: null as unknown,
}));
vi.mock("react", () => ({
  useEffect: (effect: () => () => void) => {
    mock.cleanups.push(effect());
  },
  useRef: (value: unknown) => ({ current: value }),
  useSyncExternalStore: () => 1,
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { easConfig: { projectId: "test-project" } } }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("../api", () => ({
  getSessionVersion: () => 1,
  isAuthenticated: () => mock.authenticated,
  registerDeviceForSession: mock.register,
  subscribeSession: vi.fn(),
}));
vi.mock("./tokenStorage", () => ({ readPushToken: async () => mock.retained }));
vi.mock("../refresh/usePolling", () => ({ refetchVisibleScreens: mock.refetch }));
vi.mock("expo-notifications", () => ({
  AndroidImportance: { DEFAULT: 3 },
  setNotificationChannelAsync: async () => {},
  requestPermissionsAsync: async () => ({ granted: mock.granted }),
  getExpoPushTokenAsync: mock.token,
  addPushTokenListener: () => ({ remove: mock.remove }),
  addNotificationReceivedListener: (fn: () => void) => {
    mock.received = fn;
    return { remove: mock.remove };
  },
  addNotificationResponseReceivedListener: (fn: (response: unknown) => void) => {
    mock.tapped = fn;
    return { remove: mock.remove };
  },
  getLastNotificationResponseAsync: async () => mock.cold,
  clearLastNotificationResponseAsync: async () => {},
}));
import { PushRegistration } from "./PushRegistration";

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function response(trackingNo: string) {
  return {
    notification: {
      request: { identifier: "notification-one", content: { data: { trackingNo } } },
    },
  };
}
beforeEach(() => {
  mock.cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.clearAllMocks();
  mock.authenticated = true;
  mock.granted = true;
  mock.retained = null;
  mock.cold = null;
  mock.token.mockReset().mockResolvedValue({ data: "ExpoPushToken[fake]" });
});

describe("Phase 9 native notification lifecycle", () => {
  it("registers only an authenticated supported session", async () => {
    PushRegistration();
    await settle();
    expect(mock.register).toHaveBeenCalledWith("ExpoPushToken[fake]", "android", 1);
  });
  it("permission denial and token failure do not block the app", async () => {
    mock.granted = false;
    expect(PushRegistration()).toBeNull();
    await settle();
    expect(mock.token).not.toHaveBeenCalled();
    mock.granted = true;
    mock.token.mockRejectedValue(new Error("offline"));
    expect(PushRegistration()).toBeNull();
    await settle();
    expect(mock.register).not.toHaveBeenCalled();
  });
  it("repairs retained ownership before denied permission returns early", async () => {
    mock.retained = "ExpoPushToken[retained]";
    mock.granted = false;
    PushRegistration();
    await settle();
    expect(mock.register).toHaveBeenCalledWith(mock.retained, "android", 1);
  });
  it("unmount cancels token work and removes all three native listeners", async () => {
    PushRegistration();
    mock.cleanups.splice(0).forEach((cleanup) => cleanup());
    await settle();
    expect(mock.register).not.toHaveBeenCalled();
    expect(mock.remove).toHaveBeenCalledTimes(3);
  });
  it("cold-start tap navigates once and refetches, never uses push as truth", async () => {
    mock.cold = response("YS-20260917-ABCDE");
    PushRegistration();
    await settle();
    mock.tapped?.(mock.cold);
    expect(mock.push).toHaveBeenCalledTimes(1);
    expect(mock.push).toHaveBeenCalledWith("/letters/YS-20260917-ABCDE");
    expect(mock.refetch).toHaveBeenCalledTimes(1);
    mock.received?.();
    expect(mock.refetch).toHaveBeenCalledTimes(2);
  });
  it("unauthenticated session neither registers nor follows notifications", async () => {
    mock.authenticated = false;
    PushRegistration();
    mock.tapped?.(response("YS-20260917-ABCDE"));
    await settle();
    expect(mock.register).not.toHaveBeenCalled();
    expect(mock.push).not.toHaveBeenCalled();
  });
});

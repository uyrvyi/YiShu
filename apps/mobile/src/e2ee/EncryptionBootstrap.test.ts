import { beforeEach, describe, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({
  effect: undefined as (() => undefined | (() => void)) | undefined,
  ensure: vi.fn(),
  alert: vi.fn(),
  push: vi.fn(),
  version: 1,
}));
vi.mock("react", () => ({
  useEffect: (effect: () => undefined | (() => void)) => {
    harness.effect = effect;
  },
}));
vi.mock("react-native", () => ({ Alert: { alert: harness.alert } }));
vi.mock("expo-router", () => ({ router: { push: harness.push } }));
vi.mock("../api", () => ({
  encryptionClient: { ensureReady: harness.ensure },
  getSessionVersion: () => harness.version,
}));
import { EncryptionBootstrap } from "./EncryptionBootstrap";
describe("automatic encryption after login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.version = 1;
    harness.ensure.mockResolvedValue(undefined);
  });
  it("does nothing before login and silently prepares keys after login", async () => {
    EncryptionBootstrap({ authenticated: false, version: 1 });
    harness.effect?.();
    expect(harness.ensure).not.toHaveBeenCalled();
    EncryptionBootstrap({ authenticated: true, version: 1 });
    harness.effect?.();
    await Promise.resolve();
    expect(harness.ensure).toHaveBeenCalledOnce();
    expect(harness.alert).not.toHaveBeenCalled();
  });
  it("shows recovery failure without collecting codes or replacing keys", async () => {
    harness.ensure.mockRejectedValue(new Error("e2ee_recovery_required"));
    EncryptionBootstrap({ authenticated: true, version: 1 });
    harness.effect?.();
    await Promise.resolve();
    expect(harness.alert).toHaveBeenCalledWith(
      "加密暂不可用",
      expect.stringContaining("本机没有可用密钥"),
      expect.any(Array)
    );
  });
  it("suppresses old-session errors after account switch or unmount", async () => {
    harness.ensure.mockRejectedValue(new Error("network_unavailable"));
    EncryptionBootstrap({ authenticated: true, version: 1 });
    const cleanup = harness.effect?.();
    harness.version = 2;
    if (typeof cleanup === "function") cleanup();
    await Promise.resolve();
    expect(harness.alert).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock expo-secure-store（原生模块在 Vitest 需要 mock，禁止改用 AsyncStorage）
const secureStore = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(async (k: string, v: string) => {
    secureStore.set(k, v);
  }),
  getItemAsync: vi.fn(async (k: string) => secureStore.get(k) ?? null),
  deleteItemAsync: vi.fn(async (k: string) => {
    secureStore.delete(k);
  }),
}));

import { createAuthService, type ApiAuthResponse, type ApiClient } from "./authService";
import { getRefreshToken } from "./tokenStorage";

const REGISTER_INPUT = {
  account: "alice",
  password: "alice-pass-123",
  nickname: "爱丽丝",
  province: "上海市",
  city: "上海市",
  district: "徐汇区",
};

const REAL_AUTH_RESPONSE: ApiAuthResponse = {
  user: {
    uid: "52739184",
    account: "alice",
    nickname: "爱丽丝",
    region: { province: "上海市", city: "上海市", district: "徐汇区" },
  },
  accessToken: "access-1",
  refreshToken: "refresh-1",
};

describe("authService", () => {
  beforeEach(() => {
    secureStore.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockApi(overrides?: Partial<ApiClient>): ApiClient {
    return {
      register: vi.fn(async () => REAL_AUTH_RESPONSE),
      login: vi.fn(async () => REAL_AUTH_RESPONSE),
      refresh: vi.fn(async () => ({ accessToken: "access-2" })),
      logout: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it("register 返回真实 UID（8 位数字、非空）", async () => {
    const api = mockApi();
    const svc = createAuthService(api);
    const result = await svc.register(REGISTER_INPUT);
    expect(result.user.uid).toBe("52739184");
    expect(result.user.uid).toMatch(/^[1-9][0-9]{7}$/);
    expect(result.user.uid.length).toBe(8);
  });

  it("register 返回真实 nickname / account / region（不伪造）", async () => {
    const api = mockApi();
    const svc = createAuthService(api);
    const result = await svc.register(REGISTER_INPUT);
    expect(result.user.nickname).toBe("爱丽丝");
    expect(result.user.account).toBe("alice");
    expect(result.user.region).toEqual({ province: "上海市", city: "上海市", district: "徐汇区" });
  });

  it("register 成功保存 Refresh Token 到 SecureStore", async () => {
    const api = mockApi();
    const svc = createAuthService(api);
    await svc.register(REGISTER_INPUT);
    expect(await getRefreshToken()).toBe("refresh-1");
  });

  it("login 返回真实 UID（非空）且 nickname 等于 API mock 返回值", async () => {
    const api = mockApi();
    const svc = createAuthService(api);
    const result = await svc.login("alice", "alice-pass-123");
    expect(result.user.uid).toBe("52739184");
    expect(result.user.uid.length).toBeGreaterThan(0);
    expect(result.user.nickname).toBe("爱丽丝");
  });

  it("login 成功保存 Refresh Token", async () => {
    const api = mockApi();
    const svc = createAuthService(api);
    await svc.login("alice", "alice-pass-123");
    expect(await getRefreshToken()).toBe("refresh-1");
  });

  it("refresh 从 SecureStore 读取并返回新 access token", async () => {
    const api = mockApi();
    const svc = createAuthService(api);
    await svc.login("alice", "alice-pass-123");
    const newAccess = await svc.refresh();
    expect(api.refresh).toHaveBeenCalledWith("refresh-1");
    expect(newAccess).toBe("access-2");
  });

  it("refresh 时若服务端返回新 Refresh Token 则更新 SecureStore", async () => {
    const api = mockApi({
      refresh: vi.fn(async () => ({ accessToken: "access-2", refreshToken: "refresh-2" })),
    });
    const svc = createAuthService(api);
    await svc.login("alice", "alice-pass-123");
    await svc.refresh();
    expect(await getRefreshToken()).toBe("refresh-2");
  });

  it("SecureStore 无 Refresh Token 时，refresh 不调用 API，不发送空/undefined token", async () => {
    const api = mockApi();
    const svc = createAuthService(api);
    // SecureStore 为空（getRefreshToken → null）
    const result = await svc.refresh();
    expect(result).toBeNull();
    expect(api.refresh).not.toHaveBeenCalled(); // 明确断言
    expect(secureStore.size).toBe(0); // 不产生新的 SecureStore 写入
  });

  it("logout 使用 try/finally 删除 Refresh Token（即使 API 失败也删除）", async () => {
    const api = mockApi({
      logout: vi.fn(async () => {
        throw new Error("network error");
      }),
    });
    const svc = createAuthService(api);
    await svc.login("alice", "alice-pass-123");
    await expect(svc.logout()).rejects.toThrow("network error");
    expect(await getRefreshToken()).toBeNull();
  });

  it("logout 正常路径删除 Refresh Token", async () => {
    const api = mockApi();
    const svc = createAuthService(api);
    await svc.login("alice", "alice-pass-123");
    await svc.logout();
    expect(api.logout).toHaveBeenCalledWith("refresh-1");
    expect(await getRefreshToken()).toBeNull();
  });
});

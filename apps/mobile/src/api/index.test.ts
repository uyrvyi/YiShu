import { beforeEach, describe, expect, it, vi } from "vitest";

// mock expo-constants（原生模块），提供 apiBaseUrl
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { apiBaseUrl: "https://api.example.com" } } },
}));
// mock SecureStore（authService 依赖），用可存储 Map 支持 logout 读取 refresh token
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

import {
  loginSession,
  registerSession,
  logoutSession,
  getApi,
  restoreSession,
  isAuthenticated,
} from "./index";

const REAL_LOGIN = {
  user: {
    uid: "52739184",
    account: "alice",
    nickname: "爱丽丝",
    region: { province: "上海市", city: "上海市", district: "徐汇区" },
  },
  accessToken: "access-real",
  refreshToken: "refresh-real",
};

describe("shared api session", () => {
  beforeEach(() => {
    secureStore.clear();
    vi.restoreAllMocks();
  });

  it("loginSession 调用真实 Auth API 并建立会话（access token 可用于 Letter API）", async () => {
    const fetchMock = vi
      .fn()
      // login
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => REAL_LOGIN,
      })
      // letters 列表（getApi）
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ letters: [] }),
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await loginSession("alice", "pass");
    expect(result.user.uid).toBe("52739184");
    expect(result.accessToken).toBe("access-real");

    // 登录后 getApi 应带 Bearer token 请求 /letters
    const letters = await getApi().listLetters();
    expect(letters).toEqual([]);
    const lettersCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/v1/letters"));
    const headers = (lettersCall?.[1] as RequestInit)?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-real");
  });

  it("registerSession 调用真实 Auth API 并保存 Refresh Token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ...REAL_LOGIN, refreshToken: "refresh-real" }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await registerSession({
      account: "alice",
      password: "pass",
      nickname: "爱丽丝",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    expect(result.user.uid).toBe("52739184");
    // 验证调用了 /auth/register
    const registerCall = fetchMock.mock.calls[0];
    expect(String(registerCall[0])).toContain("/api/v1/auth/register");
    const body = JSON.parse(String((registerCall[1] as RequestInit).body));
    expect(body.account).toBe("alice");
  });

  it("logoutSession 调用 /auth/logout", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => REAL_LOGIN }) // login
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) }); // logout
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await loginSession("alice", "pass");
    await logoutSession();
    const logoutCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/auth/logout"));
    expect(logoutCall).toBeDefined();
    expect(isAuthenticated()).toBe(false);
  });

  it("logout API 抛错时仍清除内存 access token（不残留认证状态）", async () => {
    // login 成功
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => REAL_LOGIN });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await loginSession("alice", "pass");
    expect(isAuthenticated()).toBe(true);

    // logout API 抛错（网络异常）
    fetchMock.mockRejectedValueOnce(new Error("network error"));
    await expect(logoutSession()).rejects.toThrow("network error");
    // finally 仍清除内存 access token
    expect(isAuthenticated()).toBe(false);
  });

  it("restoreSession：无 refresh token → unauthenticated", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const ok = await restoreSession();
    expect(ok).toBe(false);
    expect(isAuthenticated()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); // 无 token 不调 refresh
  });

  it("restoreSession：有 refresh token 且 refresh 成功 → 恢复会话", async () => {
    secureStore.set("yishu_refresh_token", "refresh-valid");
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: "access-restored" }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const ok = await restoreSession();
    expect(ok).toBe(true);
    expect(isAuthenticated()).toBe(true);
    const refreshCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/auth/refresh"));
    expect(refreshCall).toBeDefined();
  });

  it("restoreSession：refresh token 无效 → 清理本地 token，进入 unauthenticated", async () => {
    secureStore.set("yishu_refresh_token", "refresh-invalid");
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const ok = await restoreSession();
    expect(ok).toBe(false);
    expect(isAuthenticated()).toBe(false);
    // 本地 token 被清理
    expect(secureStore.has("yishu_refresh_token")).toBe(false);
  });
});

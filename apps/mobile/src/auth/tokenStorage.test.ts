import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock expo-secure-store（原生模块在 Vitest 需要 mock，禁止改用 AsyncStorage）
const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
  }),
  getItemAsync: vi.fn(async (k: string) => store.get(k) ?? null),
  deleteItemAsync: vi.fn(async (k: string) => {
    store.delete(k);
  }),
}));

import * as SecureStore from "expo-secure-store";
import { saveRefreshToken, getRefreshToken, deleteRefreshToken } from "./tokenStorage";

describe("tokenStorage (expo-secure-store)", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("save 后能 get 到 token", async () => {
    await saveRefreshToken("refresh-token-abc");
    expect(await getRefreshToken()).toBe("refresh-token-abc");
  });

  it("未保存时 get 返回 null", async () => {
    expect(await getRefreshToken()).toBeNull();
  });

  it("delete 后 get 返回 null", async () => {
    await saveRefreshToken("refresh-token-abc");
    await deleteRefreshToken();
    expect(await getRefreshToken()).toBeNull();
  });

  it("logout 清除 token（deleteRefreshToken 生效）", async () => {
    await saveRefreshToken("refresh-token-xyz");
    await deleteRefreshToken();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalled();
    expect(await getRefreshToken()).toBeNull();
  });

  it("使用 SecureStore 而非 AsyncStorage（断言调用的是 expo-secure-store）", async () => {
    await saveRefreshToken("t");
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("yishu_refresh_token", "t");
  });
});

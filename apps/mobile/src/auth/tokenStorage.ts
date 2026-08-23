import * as SecureStore from "expo-secure-store";

/**
 * Auth Token 安全存储（对应开发规范 §5）。
 *
 * Refresh Token 只能存储在 SecureStore（expo-secure-store）。
 * 禁止使用 AsyncStorage 保存 Refresh Token；禁止日志打印 token。
 */

const REFRESH_TOKEN_KEY = "yishu_refresh_token";

/**
 * 保存 Refresh Token 到 SecureStore。
 * @param token Refresh Token 明文（仅在客户端内存中短暂持有）。
 */
export async function saveRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

/**
 * 从 SecureStore 读取 Refresh Token；不存在返回 null。
 */
export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

/**
 * 删除 Refresh Token（logout 时调用）。
 */
export async function deleteRefreshToken(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}

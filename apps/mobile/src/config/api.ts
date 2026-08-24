import Constants from "expo-constants";

/**
 * 统一 API Base URL 配置。
 *
 * 唯一环境变量：`EXPO_PUBLIC_API_BASE_URL`。
 * - 开发真机必须显式配置为局域网可达地址（如 http://192.168.x.x:4000），
 *   不能使用 localhost（真机 localhost 指向手机自身）。
 * - 若未提供：fail-fast 抛错，绝不默默 fallback 到 localhost（避免"假装有配置但实际不可用"）。
 */

function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (fromEnv) {
    return fromEnv;
  }
  const extra = Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined;
  if (extra?.apiBaseUrl) {
    return extra.apiBaseUrl;
  }
  throw new Error(
    "EXPO_PUBLIC_API_BASE_URL is not configured. Set it to your dev machine's LAN address (e.g. http://192.168.x.x:4000). localhost is invalid on a real device."
  );
}

export const API_BASE_URL: string = resolveApiUrl();

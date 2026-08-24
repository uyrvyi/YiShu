import { createLetterApi, type LetterApi } from "./letterApi";
import { createAuthService, type ApiClient, type AuthSuccess } from "../auth/authService";
import { getRefreshToken, deleteRefreshToken } from "../auth/tokenStorage";
import { API_BASE_URL } from "../config/api";

/**
 * 共享 API / Session 单例。
 *
 * - API Base URL 可配置（EXPO_PUBLIC_API_BASE_URL / Expo extra），未配置时 fail-fast 抛错（无默认回退）。
 * - Auth 调用真实后端；access token 短期存于内存，refresh token 存 SecureStore。
 * - 登录/注册成功后持有 access token，可直接调用 Letter API。
 */

interface Session {
  accessToken: string | null;
}

const session: Session = { accessToken: null };

function makeAuthApiClient(baseUrl: string): ApiClient {
  return {
    register: async (input) => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw new Error(`register_failed:${res.status}`);
      }
      return (await res.json()) as {
        user: AuthSuccess["user"];
        accessToken: string;
        refreshToken: string;
      };
    },
    login: async (account, password) => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, password }),
      });
      if (!res.ok) {
        throw new Error(`login_failed:${res.status}`);
      }
      return (await res.json()) as {
        user: AuthSuccess["user"];
        accessToken: string;
        refreshToken: string;
      };
    },
    refresh: async (refreshToken) => {
      const res = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        throw new Error("refresh_failed");
      }
      return (await res.json()) as { accessToken: string; refreshToken?: string };
    },
    logout: async (refreshToken) => {
      await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    },
  };
}

const authService = createAuthService(makeAuthApiClient(API_BASE_URL));

/** 获取当前 access token（优先内存，失败则尝试 refresh）。 */
async function getAccessToken(): Promise<string | null> {
  if (session.accessToken) {
    return session.accessToken;
  }
  try {
    const token = await authService.refresh();
    if (token) {
      session.accessToken = token;
    }
    return token;
  } catch {
    return null;
  }
}

let apiSingleton: LetterApi | null = null;

/** 获取共享 Letter API 单例。 */
export function getApi(): LetterApi {
  if (!apiSingleton) {
    apiSingleton = createLetterApi({
      baseUrl: API_BASE_URL,
      getAccessToken,
    });
  }
  return apiSingleton;
}

/** 注册并建立会话。 */
export async function registerSession(input: {
  account: string;
  password: string;
  nickname: string;
  province: string;
  city: string;
  district: string;
}): Promise<AuthSuccess> {
  const result = await authService.register(input);
  session.accessToken = result.accessToken;
  return result;
}

/** 登录并建立会话。 */
export async function loginSession(account: string, password: string): Promise<AuthSuccess> {
  const result = await authService.login(account, password);
  session.accessToken = result.accessToken;
  return result;
}

/** 注销并清除会话（try/finally 确保异常时也清除内存 access token）。 */
export async function logoutSession(): Promise<void> {
  try {
    await authService.logout();
  } finally {
    // 无论 logout API 是否成功，都必须清除内存 access token（不残留认证状态）
    session.accessToken = null;
  }
}

/** 是否已认证（内存中有 access token）。 */
export function isAuthenticated(): boolean {
  return session.accessToken !== null;
}

/**
 * 恢复会话：读取 SecureStore refresh token，尝试换取 access token。
 * - 成功 → 恢复内存 access token，返回 true。
 * - 无 token / refresh 失败 → 清理本地 token，返回 false（unauthenticated）。
 */
export async function restoreSession(): Promise<boolean> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    session.accessToken = null;
    return false;
  }
  try {
    const token = await authService.refresh();
    if (token) {
      session.accessToken = token;
      return true;
    }
    // refresh 无返回 token → 视为无效，清理
    await deleteRefreshToken();
    session.accessToken = null;
    return false;
  } catch {
    // refresh token 无效 → 清理本地 token
    await deleteRefreshToken();
    session.accessToken = null;
    return false;
  }
}

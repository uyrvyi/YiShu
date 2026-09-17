import { createLetterApi, type LetterApi } from "./letterApi";
import { createAuthService, type ApiClient, type AuthSuccess } from "../auth/authService";
import { getRefreshToken, deleteRefreshToken } from "../auth/tokenStorage";
import { API_BASE_URL } from "../config/api";
import { createAuthenticatedFetch } from "./authenticatedFetch";
import { clearPushToken, readPushToken, savePushToken } from "../push/tokenStorage";

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
let sessionVersion = 0;
let loggingOut = false;
const pushRegistrations = new Set<Promise<void>>();
let initialRefresh: Promise<string | null> | null = null;
const sessionListeners = new Set<() => void>();
export const getSessionVersion = () => sessionVersion;
export const subscribeSession = (listener: () => void) => {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
};
function sessionChanged(): void {
  sessionVersion++;
  sessionListeners.forEach((fn) => fn());
}

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
  if (loggingOut) return null;
  const generation = sessionVersion;
  return (initialRefresh ??= authService
    .refresh()
    .then((token) => {
      if (loggingOut || generation !== sessionVersion) return null;
      if (token) session.accessToken = token;
      return token;
    })
    .catch(() => null)
    .finally(() => {
      initialRefresh = null;
    }));
}

const authenticatedFetch = createAuthenticatedFetch({
  token: getAccessToken,
  version: getSessionVersion,
  refresh: async () => {
    const generation = sessionVersion;
    const token = await authService.refresh();
    if (generation !== sessionVersion || loggingOut) return null;
    session.accessToken = token;
    return token;
  },
  invalidate: async () => {
    session.accessToken = null;
    loggingOut = true;
    sessionChanged();
    await deleteRefreshToken();
  },
});

export async function registerDeviceForSession(
  token: string,
  platform: "ios" | "android",
  generation: number
): Promise<void> {
  if (loggingOut || !session.accessToken || generation !== sessionVersion) return;
  const registration = (async () => {
    await getApi().registerPush(token, platform);
    await savePushToken(token);
  })();
  pushRegistrations.add(registration);
  try {
    await registration;
  } finally {
    pushRegistrations.delete(registration);
  }
}

let apiSingleton: LetterApi | null = null;

/** 获取共享 Letter API 单例。 */
export function getApi(): LetterApi {
  if (!apiSingleton) {
    apiSingleton = createLetterApi({
      baseUrl: API_BASE_URL,
      getAccessToken,
      fetchImpl: authenticatedFetch,
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
  loggingOut = false;
  sessionChanged();
  return result;
}

/** 登录并建立会话。 */
export async function loginSession(account: string, password: string): Promise<AuthSuccess> {
  const result = await authService.login(account, password);
  session.accessToken = result.accessToken;
  loggingOut = false;
  sessionChanged();
  return result;
}

/** 注销并清除会话（try/finally 确保异常时也清除内存 access token）。 */
export async function logoutSession(): Promise<void> {
  // Fence permission/token work first, then wait only for bounded in-flight server registration.
  loggingOut = true;
  await Promise.allSettled([...pushRegistrations]);
  try {
    const token = await readPushToken();
    if (token && session.accessToken) {
      await getApi().unregisterPush(token);
      await clearPushToken();
    }
  } catch {
    /* keep the token in SecureStore; next login rebinds ownership, expiry bounds stale registrations */
  }
  try {
    await authService.logout();
  } finally {
    // 无论 logout API 是否成功，都必须清除内存 access token（不残留认证状态）
    session.accessToken = null;
    sessionChanged();
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
  loggingOut = false;
  const generation = sessionVersion;
  const refreshToken = await getRefreshToken();
  if (generation !== sessionVersion || loggingOut) return false;
  if (!refreshToken) {
    session.accessToken = null;
    return false;
  }
  try {
    const token = await authService.refresh();
    if (generation !== sessionVersion || loggingOut) return false;
    if (token) {
      session.accessToken = token;
      sessionChanged();
      return true;
    }
    // refresh 无返回 token → 视为无效，清理
    await deleteRefreshToken();
    session.accessToken = null;
    return false;
  } catch {
    if (generation !== sessionVersion || loggingOut) return false;
    // refresh token 无效 → 清理本地 token
    await deleteRefreshToken();
    session.accessToken = null;
    return false;
  }
}

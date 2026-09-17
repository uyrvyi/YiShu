import { saveRefreshToken, getRefreshToken, deleteRefreshToken } from "./tokenStorage";

/**
 * 驿书 Mobile Auth Service（最小认证流程）。
 *
 * - register / login 成功后保存 Refresh Token 到 SecureStore。
 * - refresh 从 SecureStore 读取 Refresh Token。
 * - logout 使用 try/finally 确保删除 Refresh Token。
 * - Refresh Token 只存 SecureStore，禁止 AsyncStorage，禁止日志打印 token。
 * - user 数据直接映射服务端真实响应，禁止伪造/占位字段，禁止暴露 internal id。
 *
 * 通过注入 ApiClient 实现可测试性（测试使用 mock API）。
 */

/** 服务端返回的用户安全结构（不含 internal id / passwordHash）。 */
export interface AuthUser {
  uid: string;
  account: string;
  nickname: string;
  region: {
    province: string;
    city: string;
    district: string;
  };
}

/** 服务端认证响应结构（register / login）。 */
export interface ApiAuthResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

/** 注册输入。 */
export interface RegisterInput {
  account: string;
  password: string;
  nickname: string;
  province: string;
  city: string;
  district: string;
}

/** 最小 API 客户端接口（便于注入 mock），返回服务端真实结构。 */
export interface ApiClient {
  register(input: RegisterInput): Promise<ApiAuthResponse>;
  login(account: string, password: string): Promise<ApiAuthResponse>;
  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string }>;
  logout(refreshToken: string): Promise<void>;
}

/** 认证成功结果：真实用户数据 + access token。 */
export interface AuthSuccess {
  user: AuthUser;
  accessToken: string;
}

export interface AuthService {
  register(input: RegisterInput): Promise<AuthSuccess>;
  login(account: string, password: string): Promise<AuthSuccess>;
  refresh(): Promise<string | null>;
  logout(): Promise<void>;
}

/** 使用给定 API client 构建 AuthService。 */
export function createAuthService(api: ApiClient): AuthService {
  return {
    async register(input) {
      const response = await api.register(input);
      // 注册成功后保存 Refresh Token 到 SecureStore
      await saveRefreshToken(response.refreshToken);
      // 直接映射服务端真实 user，不伪造字段
      return { user: response.user, accessToken: response.accessToken };
    },

    async login(account, password) {
      const response = await api.login(account, password);
      // 登录成功后保存 Refresh Token 到 SecureStore
      await saveRefreshToken(response.refreshToken);
      return { user: response.user, accessToken: response.accessToken };
    },

    async refresh() {
      const token = await getRefreshToken();
      if (!token) {
        // Refresh Token 不存在：不调用 API，返回 null（未认证）
        return null;
      }
      const result = await api.refresh(token);
      // A late refresh must not overwrite credentials established by another login/logout.
      if ((await getRefreshToken()) !== token) return null;
      // 若服务端返回新的 Refresh Token，更新 SecureStore
      if (result.refreshToken) {
        await saveRefreshToken(result.refreshToken);
      }
      return result.accessToken;
    },

    async logout() {
      // try/finally 确保无论 API 是否成功都删除本地 Refresh Token
      try {
        const token = await getRefreshToken();
        if (token) {
          await api.logout(token);
        }
      } finally {
        await deleteRefreshToken();
      }
    },
  };
}

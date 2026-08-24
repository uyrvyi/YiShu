import type { LetterStatus, RecipientReadState, TransportType } from "@yishu/shared";

/**
 * Mobile Letter API 服务（最小真实流程）。
 *
 * 通过注入 fetch 与 access token 提供器实现可测试性。
 * 类型统一来自 @yishu/shared。
 */

export interface JourneyLegView {
  sequence: number;
  from: { name: string };
  to: { name: string };
  transportType: TransportType;
  distanceKm: number;
  status: string;
}

export interface JourneyView {
  origin: { name: string };
  destination: { name: string };
  totalDistanceKm: number;
  status: string;
  legs: JourneyLegView[];
}

export interface LetterView {
  trackingNo: string;
  status: LetterStatus;
  initialTransport: TransportType;
  currentTransport: TransportType;
  origin: { province: string; city: string; district: string };
  target: { province: string; city: string; district: string };
  sentAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  content: string | null;
  sender: { account: string; uid: string; nickname: string };
  recipient: { account: string; uid: string; nickname: string };
  readState?: RecipientReadState;
  /** Phase 4 Journey 摘要（用户可见，无 internal id / seed / ETA）。 */
  journey?: JourneyView | null;
}

export interface UserSearchResult {
  account: string;
  uid: string;
  nickname: string;
  region: { province: string; city: string; district: string };
}

export interface CreateLetterInput {
  recipient: string;
  content: string;
  transportType: TransportType;
  clientRequestId: string;
}

export interface LetterApiDeps {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

/** 构建 Letter API 客户端（可注入 fetch/token）。 */
export function createLetterApi(deps: LetterApiDeps) {
  const doFetch = deps.fetchImpl ?? fetch;

  async function headers(): Promise<Record<string, string>> {
    const token = await deps.getAccessToken();
    const h: Record<string, string> = { "content-type": "application/json" };
    if (token) {
      h.authorization = `Bearer ${token}`;
    }
    return h;
  }

  return {
    /** 我的信件列表（寄出/收到/全部）。 */
    async listLetters(direction?: "sent" | "received"): Promise<LetterView[]> {
      const q = direction ? `?direction=${direction}` : "";
      const res = await doFetch(`${deps.baseUrl}/api/v1/letters${q}`, {
        method: "GET",
        headers: await headers(),
      });
      if (!res.ok) {
        throw new Error(`list_letters_failed:${res.status}`);
      }
      const body = (await res.json()) as { letters: LetterView[] };
      return body.letters;
    },

    /** 信件详情。 */
    async getLetter(trackingNo: string): Promise<LetterView> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/letters/${trackingNo}`, {
        method: "GET",
        headers: await headers(),
      });
      if (!res.ok) {
        throw new Error(`get_letter_failed:${res.status}`);
      }
      const body = (await res.json()) as { letter: LetterView };
      return body.letter;
    },

    /** 创建信件。 */
    async createLetter(input: CreateLetterInput): Promise<LetterView> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/letters`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw new Error(`create_letter_failed:${res.status}`);
      }
      const body = (await res.json()) as { letter: LetterView };
      return body.letter;
    },

    /** 搜索收件人（完整 account 或 8 位 UID 精准确认）。 */
    async searchRecipient(q: string): Promise<UserSearchResult> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/users/search?q=${encodeURIComponent(q)}`, {
        method: "GET",
        headers: await headers(),
      });
      if (res.status === 404) {
        throw new Error("user_not_found");
      }
      if (!res.ok) {
        throw new Error(`search_failed:${res.status}`);
      }
      return (await res.json()) as UserSearchResult;
    },
  };
}

export type LetterApi = ReturnType<typeof createLetterApi>;

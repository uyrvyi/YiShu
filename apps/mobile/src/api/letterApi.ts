import {
  routeMapViewSchema,
  nextStationEstimateSchema,
  transportEstimatesSchema,
  type NextStationEstimate,
  type TransportEstimate,
  type PublicLetterStatus,
  type RecipientReadState,
  type RouteMapViewParsed,
  type TimelineEventType,
  type TransportType,
} from "@yishu/shared";
import type { AuthUser } from "../auth/authService";

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
  /**
   * 用户可见状态：服务端只返回 PublicLetterStatus（内部 `LETTER_DROPPED` 等 HIDDEN 状态绝不出现）。
   * 客户端契约与 `@yishu/shared` 的 `toPublicLetterStatus` 保持一致，不得在此接受内部 LetterStatus。
   */
  status: PublicLetterStatus;
  initialTransport: TransportType;
  currentTransport: TransportType;
  origin: { province: string; city: string; district: string };
  target: { province: string; city: string; district: string };
  sentAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  content: string | null;
  writtenAt?: string | null;
  images?: LetterImage[];
  sender: { account: string; uid: string; nickname: string };
  recipient: { account: string; uid: string; nickname: string };
  readState?: RecipientReadState;
  /** Phase 4 Journey 摘要（用户可见，无 internal id / seed / ETA）。 */
  journey?: JourneyView | null;
}

export interface UserSearchResult {
  avatarUrl?: string | null;
  account: string;
  uid: string;
  nickname: string;
  region: { province: string; city: string; district: string };
}

export interface TimelineFact {
  type: TimelineEventType;
  title: string;
  description: string;
  location: { province: string; city: string };
  happenedAt: string;
}

export class LetterApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
    this.name = "LetterApiError";
  }
}

export interface CreateLetterInput {
  recipient: string;
  content: string;
  transportType: TransportType;
  clientRequestId: string;
  writtenAt?: string;
  imageIds?: string[];
}

export interface LetterImage {
  id: string;
  url: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
}

export interface UploadImageInput {
  uri: string;
  name: string;
  mimeType: string;
}

export function imageDataUrl(buffer: ArrayBuffer, mimeType: string): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export interface LetterApiDeps {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

/** 构建 Letter API 客户端（可注入 fetch/token）。 */
export function createLetterApi(deps: LetterApiDeps) {
  const doFetch = deps.fetchImpl ?? fetch;

  async function failure(res: Response, fallback: string): Promise<LetterApiError> {
    const body: unknown = await res.json().catch(() => null);
    const code =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : fallback;
    return new LetterApiError(code, res.status);
  }

  async function headers(hasJsonBody = false): Promise<Record<string, string>> {
    const token = await deps.getAccessToken();
    const h: Record<string, string> = {};
    if (hasJsonBody) {
      h["content-type"] = "application/json";
    }
    if (token) {
      h.authorization = `Bearer ${token}`;
    }
    return h;
  }

  return {
    async updateProfile(input: {
      nickname?: string;
      region?: AuthUser["region"];
    }): Promise<AuthUser> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/users/me`, {
        method: "PATCH",
        headers: await headers(true),
        body: JSON.stringify(input),
      });
      if (!res.ok) throw await failure(res, "profile_update_failed");
      return ((await res.json()) as { user: AuthUser }).user;
    },
    async uploadImage(
      input: UploadImageInput,
      avatar = false,
      onProgress?: import("./imageUploadFetch").UploadProgressCallback
    ): Promise<LetterImage> {
      let form: FormData | undefined;
      if (!onProgress) {
        const { File } = await import("expo-file-system");
        form = new FormData();
        // Expo 57 fetch reads File bytes; URI-only React Native parts are unsupported.
        form.append("image", new File(input.uri), input.name);
      }
      const request: import("./imageUploadFetch").ImageUploadRequestInit = {
        method: "POST",
        headers: await headers(),
        body: form,
        signal: AbortSignal.timeout(120000),
        ...(onProgress ? { imageUpload: { image: input, onProgress } } : {}),
      };
      const res = await doFetch(
        `${deps.baseUrl}/api/v1/${avatar ? "users/me/avatar" : "media/images"}`,
        request
      );
      if (!res.ok) throw await failure(res, "image_upload_failed");
      return ((await res.json()) as { image: LetterImage }).image;
    },
    async deleteStagedImage(id: string): Promise<void> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/media/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: await headers(),
      });
      if (!res.ok) throw await failure(res, "image_delete_failed");
    },
    async getImageData(id: string, preview = true): Promise<string> {
      const res = await doFetch(
        `${deps.baseUrl}/api/v1/media/${encodeURIComponent(id)}${preview ? "?size=preview" : ""}`,
        {
          headers: await headers(),
          signal: AbortSignal.timeout(60000),
        }
      );
      if (!res.ok) throw await failure(res, "image_read_failed");
      const mimeType = res.headers.get("content-type")?.split(";")[0] ?? "";
      if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(mimeType))
        throw new LetterApiError("invalid_image", 415);
      return imageDataUrl(await res.arrayBuffer(), mimeType);
    },
    async getTransportEstimates(recipient: string): Promise<TransportEstimate[]> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/transport-estimates`, {
        method: "POST",
        headers: await headers(true),
        body: JSON.stringify({ recipient }),
      });
      if (!res.ok) throw await failure(res, "transport_estimate_failed");
      return transportEstimatesSchema.parse(await res.json()).estimates;
    },
    async getNextStationEstimate(trackingNo: string): Promise<NextStationEstimate> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/letters/${trackingNo}/estimate`, {
        method: "GET",
        headers: await headers(),
      });
      if (!res.ok) throw await failure(res, "next_station_estimate_failed");
      return nextStationEstimateSchema.parse(await res.json());
    },
    async getCurrentUser(): Promise<AuthUser> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/users/me`, {
        method: "GET",
        headers: await headers(),
      });
      if (!res.ok) throw await failure(res, "get_user_failed");
      const body = (await res.json()) as { user: AuthUser };
      return body.user;
    },
    async registerPush(token: string, platform: "ios" | "android"): Promise<void> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/push/register`, {
        method: "POST",
        headers: await headers(true),
        body: JSON.stringify({ token, platform }),
      });
      if (!res.ok) throw new Error(`push_register_failed:${res.status}`);
    },
    async unregisterPush(token: string): Promise<void> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/push/unregister`, {
        method: "DELETE",
        headers: await headers(true),
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error(`push_unregister_failed:${res.status}`);
    },
    async getTimeline(trackingNo: string): Promise<TimelineFact[]> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/letters/${trackingNo}/timeline`, {
        method: "GET",
        headers: await headers(),
      });
      if (!res.ok) throw await failure(res, "get_timeline_failed");
      const body = (await res.json()) as { timeline: TimelineFact[] };
      return body.timeline;
    },
    /** 我的信件列表（寄出/收到/全部）。 */
    async listLetters(direction?: "sent" | "received"): Promise<LetterView[]> {
      const q = direction ? `?direction=${direction}` : "";
      const res = await doFetch(`${deps.baseUrl}/api/v1/letters${q}`, {
        method: "GET",
        headers: await headers(),
      });
      if (!res.ok) {
        throw await failure(res, "list_letters_failed");
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
        throw await failure(res, "get_letter_failed");
      }
      const body = (await res.json()) as { letter: LetterView };
      return body.letter;
    },

    /**
     * 信件旅程地图（Phase 8 §74）。
     *
     * 使用 `@yishu/shared` 的 `routeMapViewSchema` **strip-parse**：
     * - 任何意外多出的内部字段（internal id / dropArea / 掉落原因等）在进入 UI 前被剥离；
     * - 解析失败（结构不符）直接抛错，不静默降级。
     * 客户端不请求、不推导、不渲染掉落范围（`LETTER_DROPPED` 全局 HIDDEN）。
     */
    async getRouteMap(trackingNo: string): Promise<RouteMapViewParsed> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/letters/${trackingNo}/map`, {
        method: "GET",
        headers: await headers(),
      });
      if (!res.ok) {
        throw await failure(res, "get_route_map_failed");
      }
      return routeMapViewSchema.parse(await res.json());
    },

    /** 创建信件。 */
    async createLetter(input: CreateLetterInput): Promise<LetterView> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/letters`, {
        method: "POST",
        headers: await headers(true),
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw await failure(res, "create_letter_failed");
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
        throw await failure(res, "search_failed");
      }
      return (await res.json()) as UserSearchResult;
    },
    async initializeJourney(trackingNo: string): Promise<JourneyView> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/letters/${trackingNo}/journey`, {
        method: "POST",
        headers: await headers(),
      });
      if (!res.ok) throw await failure(res, "journey_failed");
      const body = (await res.json()) as { journey: JourneyView };
      return body.journey;
    },
    async getJourney(trackingNo: string): Promise<JourneyView> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/letters/${trackingNo}/journey`, {
        method: "GET",
        headers: await headers(),
      });
      if (!res.ok) throw await failure(res, "get_journey_failed");
      const body = (await res.json()) as { journey: JourneyView };
      return body.journey;
    },
    async openLetter(trackingNo: string): Promise<void> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/letters/${trackingNo}/open`, {
        method: "POST",
        headers: await headers(),
      });
      if (!res.ok) throw await failure(res, "open_failed");
    },
    async hideLetter(trackingNo: string): Promise<void> {
      const res = await doFetch(`${deps.baseUrl}/api/v1/letters/${trackingNo}/hide`, {
        method: "POST",
        headers: await headers(),
      });
      if (!res.ok) throw await failure(res, "hide_failed");
    },
  };
}

export type LetterApi = ReturnType<typeof createLetterApi>;

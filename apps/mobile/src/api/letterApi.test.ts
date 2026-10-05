import { afterEach, describe, expect, it, vi } from "vitest";
import { createLetterApi, type LetterApi } from "./letterApi";
import { convertFormDataAsync } from "expo/src/winter/fetch/convertFormData";

const BASE = "https://api.example.com";
const TOKEN = "access-token-1";
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    name = "photo.png";
    type = "image/png";
    bytes = async () => new Uint8Array([1, 2, 3]);
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
});

const LETTER = {
  trackingNo: "YS-20260821-K7P2M",
  status: "CREATED",
  initialTransport: "HORSE_RELAY",
  currentTransport: "HORSE_RELAY",
  origin: { province: "上海市", city: "上海市", district: "徐汇区" },
  target: { province: "北京市", city: "北京市", district: "海淀区" },
  sentAt: null,
  deliveredAt: null,
  createdAt: "2026-08-21T00:00:00.000Z",
  content: null,
  sender: { account: "alice", uid: "12345678", nickname: "Alice" },
  recipient: { account: "bobby", uid: "87654321", nickname: "Bob" },
};

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<unknown>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const result = await handler(String(url), init);
    return {
      ok: true,
      status: 200,
      json: async () => result,
    } as Response;
  });
}

describe("letterApi", () => {
  it("passes native upload metadata without constructing an unused JS multipart body", async () => {
    vi.stubGlobal(
      "FormData",
      class {
        constructor() {
          throw new Error("native uploads must not construct FormData");
        }
      }
    );
    const input = { uri: "file:photo.jpg", name: "photo.jpg", mimeType: "image/jpeg" };
    const progress = vi.fn();
    const fetchMock = mockFetch(async (_url, init) => {
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
      expect((init as import("./imageUploadFetch").ImageUploadRequestInit).imageUpload).toEqual({
        image: input,
        onProgress: progress,
      });
      return { image: { id: "uploaded" } };
    });
    expect(await makeApi(fetchMock as typeof fetch).uploadImage(input, false, progress)).toEqual({
      id: "uploaded",
    });
  });
  it("passes the installed Expo multipart encoder; the former URI-only part is rejected", async () => {
    class ExpoForm {
      parts: Array<[string, unknown]> = [];
      append(name: string, value: unknown) {
        this.parts.push([name, value]);
      }
      entries() {
        return this.parts.values();
      }
    }
    vi.stubGlobal("FormData", ExpoForm);
    const previous = new ExpoForm();
    previous.append("image", { uri: "file:photo", name: "photo.png", type: "image/png" });
    await expect(convertFormDataAsync(previous as unknown as FormData)).rejects.toThrow(
      "Unsupported FormDataPart implementation"
    );
    const fetchMock = mockFetch(async (_url, init) => {
      const encoded = await convertFormDataAsync(init?.body as FormData, "test-boundary");
      expect(encoded.body).toContain(1);
      expect(encoded.body).toContain(2);
      expect(new TextDecoder().decode(encoded.body)).toContain('filename="photo.png"');
      return { image: { id: "uploaded" } };
    });
    expect(
      await makeApi(fetchMock as typeof fetch).uploadImage({
        uri: "file:photo",
        name: "photo.png",
        mimeType: "image/png",
      })
    ).toEqual({ id: "uploaded" });
  });
  it("only sends the changed profile field, without overwriting the other editor", async () => {
    const fetchMock = mockFetch(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ nickname: "Edited" });
      return { user: { nickname: "Edited" } };
    });
    await makeApi(fetchMock as typeof fetch).updateProfile({ nickname: "Edited" });
  });
  it("uploads readable File objects compatible with Expo fetch, with authentication and automatic boundary", async () => {
    class NativeFormData {
      parts: unknown[] = [];
      append(...args: unknown[]) {
        this.parts.push(args);
      }
    }
    vi.stubGlobal("FormData", NativeFormData);
    const image = {
      id: "image-id",
      url: "/api/v1/media/image-id",
      mimeType: "image/png",
      width: 24,
      height: 16,
      byteSize: 100,
    };
    const calls: string[] = [];
    const fetchMock = mockFetch(async (url, init) => {
      calls.push(url);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
      const parts = (init?.body as unknown as NativeFormData).parts as Array<
        [string, { uri: string; bytes: () => Promise<Uint8Array> }, string]
      >;
      expect(parts[0]?.[0]).toBe("image");
      expect(parts[0]?.[1].uri).toBe("file:photo");
      expect(await parts[0]?.[1].bytes()).toEqual(new Uint8Array([1, 2, 3]));
      expect(parts[0]?.[2]).toBe("letter.png");
      return { image };
    });
    const api = makeApi(fetchMock as typeof fetch);
    expect(
      await api.uploadImage({ uri: "file:photo", name: "letter.png", mimeType: "image/png" })
    ).toEqual(image);
    await api.uploadImage({ uri: "file:photo", name: "letter.png", mimeType: "image/png" }, true);
    expect(calls).toEqual([`${BASE}/api/v1/media/images`, `${BASE}/api/v1/users/me/avatar`]);
  });
  it("reads protected thumbnails and originals with the session instead of public image URLs", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as Response;
    });
    const api = makeApi(fetchMock as typeof fetch);
    expect(await api.getImageData("safe-id")).toBe("data:image/png;base64,AQID");
    await api.getImageData("safe-id", false);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${BASE}/api/v1/media/safe-id?size=preview`,
      `${BASE}/api/v1/media/safe-id`,
    ]);
  });
  it("rejects active image formats before reading response pixels", async () => {
    const read = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          headers: new Headers({ "content-type": "image/svg+xml" }),
          arrayBuffer: read,
        }) as unknown as Response
    );
    await expect(makeApi(fetchMock as typeof fetch).getImageData("safe-id")).rejects.toMatchObject({
      code: "invalid_image",
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("saves editable profile fields with PATCH and preserves avatar metadata", async () => {
    const input = {
      nickname: "Edited",
      region: { province: "上海市", city: "上海市", district: "徐汇区" },
    };
    const user = {
      ...input,
      account: "alice",
      uid: "12345678",
      avatarUrl: "/api/v1/media/safe-id",
    };
    const fetchMock = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/v1/users/me`);
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return { user };
    });
    expect(await makeApi(fetchMock as typeof fetch).updateProfile(input)).toEqual(user);
  });
  it("寄送预估接口认证后只返回安全字段", async () => {
    const fetchMock = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/v1/transport-estimates`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ recipient: "87654321" });
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
      return {
        estimates: [
          {
            transportType: "PIGEON",
            distanceKm: 1000,
            durationSeconds: 21600,
            internalId: "secret",
          },
        ],
      };
    });
    expect(await makeApi(fetchMock as typeof fetch).getTransportEstimates("87654321")).toEqual([
      { transportType: "PIGEON", distanceKm: 1000, durationSeconds: 21600 },
    ]);
  });

  it("下一站时长接口 strip 未知字段", async () => {
    const fetchMock = mockFetch(async (url) => {
      expect(url).toBe(`${BASE}/api/v1/letters/YS-20260821-K7P2M/estimate`);
      return {
        state: "ON_THE_WAY",
        remainingSeconds: 123,
        asOf: "2026-09-30T00:00:00.000Z",
        nodeId: "hidden",
      };
    });
    expect(
      await makeApi(fetchMock as typeof fetch).getNextStationEstimate("YS-20260821-K7P2M")
    ).toEqual({ state: "ON_THE_WAY", remainingSeconds: 123, asOf: "2026-09-30T00:00:00.000Z" });
  });
  function makeApi(fetchImpl: typeof fetch): LetterApi {
    return createLetterApi({
      baseUrl: BASE,
      getAccessToken: async () => TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
    });
  }

  it("listLetters 发起 GET /letters 并带 Bearer token", async () => {
    const fetchMock = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/v1/letters`);
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
      return { letters: [LETTER] };
    });
    const api = makeApi(fetchMock as typeof fetch);
    const letters = await api.listLetters();
    expect(letters.length).toBe(1);
    expect(letters[0].trackingNo).toBe("YS-20260821-K7P2M");
  });

  it("createLetter 发起 POST 并传正文/transport/recipient", async () => {
    const fetchMock = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/v1/letters`);
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
      const body = JSON.parse(String(init?.body));
      expect(body.recipient).toBe("bobby");
      expect(body.transportType).toBe("HORSE_RELAY");
      return { letter: LETTER };
    });
    const api = makeApi(fetchMock as typeof fetch);
    const letter = await api.createLetter({
      recipient: "bobby",
      content: "hello",
      transportType: "HORSE_RELAY",
      clientRequestId: "cr-1",
    });
    expect(letter.status).toBe("CREATED");
  });

  it("getLetter 发起 GET /letters/:trackingNo", async () => {
    const fetchMock = mockFetch(async (url) => {
      expect(url).toBe(`${BASE}/api/v1/letters/YS-20260821-K7P2M`);
      return { letter: LETTER };
    });
    const api = makeApi(fetchMock as typeof fetch);
    const letter = await api.getLetter("YS-20260821-K7P2M");
    expect(letter.trackingNo).toBe("YS-20260821-K7P2M");
  });

  it("getCurrentUser 获取我的账号信息", async () => {
    const user = {
      uid: "12345678",
      account: "alice",
      nickname: "Alice",
      region: { province: "上海市", city: "上海市", district: "徐汇区" },
    };
    const fetchMock = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/v1/users/me`);
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
      return { user };
    });
    await expect(makeApi(fetchMock as typeof fetch).getCurrentUser()).resolves.toEqual(user);
  });

  it("getJourney 读取寄件人的独立寄送方案", async () => {
    const journey = {
      origin: { name: "上海站" },
      destination: { name: "北京站" },
      totalDistanceKm: 1200,
      status: "IN_TRANSIT",
      legs: [],
    };
    const fetchMock = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/v1/letters/${LETTER.trackingNo}/journey`);
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
      return { journey };
    });
    await expect(makeApi(fetchMock as typeof fetch).getJourney(LETTER.trackingNo)).resolves.toEqual(
      journey
    );
  });

  it("旅程初始化、时间线、拆信和隐藏调用正确端点", async () => {
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: BodyInit | null;
    }> = [];
    const fetchMock = mockFetch(async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string>,
        body: init?.body,
      });
      if (url.endsWith("/journey")) return { journey: { status: "IN_TRANSIT", legs: [] } };
      if (url.endsWith("/timeline"))
        return {
          timeline: [
            {
              type: "DISPATCHED",
              title: "已寄出",
              description: "",
              location: { province: "上海市", city: "上海市" },
              happenedAt: "2026-09-01T00:00:00Z",
            },
          ],
        };
      return { ok: true };
    });
    const api = makeApi(fetchMock as typeof fetch);
    await api.initializeJourney(LETTER.trackingNo);
    const timeline = await api.getTimeline(LETTER.trackingNo);
    await api.openLetter(LETTER.trackingNo);
    await api.hideLetter(LETTER.trackingNo);
    expect(timeline[0]?.type).toBe("DISPATCHED");
    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: `${BASE}/api/v1/letters/${LETTER.trackingNo}/journey`, method: "POST" },
      { url: `${BASE}/api/v1/letters/${LETTER.trackingNo}/timeline`, method: "GET" },
      { url: `${BASE}/api/v1/letters/${LETTER.trackingNo}/open`, method: "POST" },
      { url: `${BASE}/api/v1/letters/${LETTER.trackingNo}/hide`, method: "POST" },
    ]);
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.headers["content-type"]).toBeUndefined();
      expect(call.body).toBeUndefined();
    }
  });

  it("路线不可用时保留服务端业务错误", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: false,
          status: 422,
          json: async () => ({ error: "no_station_mapping" }),
        }) as Response
    );
    await expect(
      makeApi(fetchMock as typeof fetch).initializeJourney(LETTER.trackingNo)
    ).rejects.toMatchObject({ code: "no_station_mapping", status: 422 });
  });

  it("searchRecipient 对不存在用户抛 user_not_found", async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response
    );
    const api = makeApi(fetchMock as typeof fetch);
    await expect(api.searchRecipient("nobody")).rejects.toThrow("user_not_found");
  });

  function mockMapFetch(body: unknown) {
    return vi.fn(
      async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
    );
  }

  const ROUTE_MAP = {
    status: "IN_TRANSIT",
    origin: { name: "上海站", province: "上海市", city: "上海市", x: 812.4, y: 231.2 },
    destination: { name: "北京站", province: "北京市", city: "北京市", x: 823.4, y: 192.6 },
    completedPath: [
      { x: 812.4, y: 231.2 },
      { x: 815.1, y: 224.7 },
    ],
    remainingPath: [{ x: 815.1, y: 224.7 }],
    approximatePosition: { x: 813.2, y: 228.1 },
    lastKnownPosition: { x: 812.4, y: 231.2 },
    facts: [
      {
        type: "DISPATCHED",
        title: "已寄出",
        description: "信件已从上海站寄出",
        location: { province: "上海市", city: "上海市" },
        happenedAt: "2026-09-01T00:00:00.000Z",
        x: 812.4,
        y: 231.2,
      },
    ],
  };

  it("getRouteMap 发起 GET /letters/:trackingNo/map 并解析契约", async () => {
    const fetchMock = mockMapFetch(ROUTE_MAP);
    const api = makeApi(fetchMock as typeof fetch);
    const map = await api.getRouteMap("YS-20260821-K7P2M");

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0];
    expect(String(calledUrl)).toBe(`${BASE}/api/v1/letters/YS-20260821-K7P2M/map`);
    expect(map.status).toBe("IN_TRANSIT");
    expect(map.approximatePosition).toEqual({ x: 813.2, y: 228.1 });
    expect(map.facts.length).toBe(1);
  });

  it("getRouteMap 剥离服务端意外多出的内部字段（dropArea / ETA / 掉落原因）", async () => {
    const fetchMock = mockMapFetch({
      ...ROUTE_MAP,
      letterId: "12345",
      dropArea: { radiusKm: 20, center: { x: 1, y: 2 } },
      dropReason: "LETTER_DROPPED",
      etaSeconds: 3600,
      internalStatus: "LETTER_DROPPED",
    });
    const api = makeApi(fetchMock as typeof fetch);
    const map = await api.getRouteMap("YS-20260821-K7P2M");

    for (const forbidden of [
      "dropArea",
      "dropReason",
      "etaSeconds",
      "letterId",
      "internalStatus",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(map, forbidden)).toBe(false);
    }
  });

  it("getRouteMap 拒绝内部 HIDDEN 状态（LETTER_DROPPED 不得作为 status 流出）", async () => {
    const fetchMock = mockMapFetch({ ...ROUTE_MAP, status: "LETTER_DROPPED" });
    const api = makeApi(fetchMock as typeof fetch);
    await expect(api.getRouteMap("YS-20260821-K7P2M")).rejects.toThrow();
  });

  it("getRouteMap 结构不符时抛错（不静默降级）", async () => {
    const withoutFacts: Record<string, unknown> = { ...ROUTE_MAP };
    delete withoutFacts.facts;
    const fetchMock = mockMapFetch(withoutFacts);
    const api = makeApi(fetchMock as typeof fetch);
    await expect(api.getRouteMap("YS-20260821-K7P2M")).rejects.toThrow();
  });
});

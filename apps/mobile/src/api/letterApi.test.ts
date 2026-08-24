import { describe, expect, it, vi } from "vitest";
import { createLetterApi, type LetterApi } from "./letterApi";

const BASE = "https://api.example.com";
const TOKEN = "access-token-1";

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

  it("searchRecipient 对不存在用户抛 user_not_found", async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response
    );
    const api = makeApi(fetchMock as typeof fetch);
    await expect(api.searchRecipient("nobody")).rejects.toThrow("user_not_found");
  });
});

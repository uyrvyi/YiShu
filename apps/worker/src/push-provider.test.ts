import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpoPushProvider } from "./push-provider.js";
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("remote push provider boundary", () => {
  it("uses the high-importance Android channel with audible delivery and safe payload", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { status: "ok", id: "ticket" } }),
    }));
    vi.stubGlobal("fetch", fetch);
    const message = {
      title: "驿书",
      body: "有一封信已送达",
      data: { trackingNo: "YS-20261003-ABCDE" },
    };
    expect(await new ExpoPushProvider().send("ExpoPushToken[test]", message)).toEqual({
      status: "ok",
      ticketId: "ticket",
    });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      to: "ExpoPushToken[test]",
      sound: "default",
      channelId: "letters-v2",
      priority: "high",
      ...message,
    });
  });
  it("does not equate a send ticket to actual delivery and revokes invalid devices", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: { ticket: { status: "error", details: { error: "DeviceNotRegistered" } } },
      }),
    }));
    vi.stubGlobal("fetch", fetch);
    expect(await new ExpoPushProvider().receipt("ticket")).toBe("invalid");
  });
  it("keeps provider failures and raw response details out of app errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret provider credentials")));
    expect(
      await new ExpoPushProvider().send("ExpoPushToken[test]", {
        title: "驿书",
        body: "新信",
        data: { trackingNo: "YS-20261003-ABCDE" },
      })
    ).toEqual({ status: "retry" });
  });
});

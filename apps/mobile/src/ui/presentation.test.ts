import { describe, expect, it } from "vitest";
import type { LetterView } from "../api/letterApi";
import { bodyTextFor, isTerminal, problemMessage, statusCopy, statusTone } from "./presentation";
import { LetterApiError } from "../api/letterApi";

const letter: LetterView = {
  trackingNo: "YS-20260901-ABCDE",
  status: "IN_TRANSIT",
  initialTransport: "HORSE_RELAY",
  currentTransport: "HORSE_RELAY",
  origin: { province: "上海市", city: "上海市", district: "徐汇区" },
  target: { province: "北京市", city: "北京市", district: "海淀区" },
  sentAt: "2026-09-01T00:00:00Z",
  deliveredAt: null,
  createdAt: "2026-09-01T00:00:00Z",
  content: "secret",
  sender: { account: "alice", uid: "12345678", nickname: "Alice" },
  recipient: { account: "bobx", uid: "87654321", nickname: "Bob" },
};

describe("letter presentation", () => {
  it("状态颜色只表达公开状态，不把异常或未寄出信件标成正常在途", () => {
    expect(statusTone("CREATED")).toBe("muted");
    expect(statusTone("IN_TRANSIT")).toBe("green");
    expect(statusTone("DELIVERED")).toBe("green");
    for (const status of ["DELAYED", "COURIER_MISSING", "LETTER_MISSING"] as const) {
      expect(statusTone(status)).toBe("orange");
    }
    expect(statusTone("PERMANENTLY_LOST")).toBe("error");
    expect(statusTone("DESTROYED")).toBe("error");
  });
  it("收件人在送达并拆阅前始终看不到正文；发件人可看自己的正文", () => {
    expect(bodyTextFor({ ...letter, readState: "OPENED" })).toBeNull();
    expect(bodyTextFor({ ...letter, status: "DELIVERED", readState: "UNOPENED" })).toBeNull();
    expect(bodyTextFor({ ...letter, status: "DELIVERED", readState: "OPENED" })).toBe("secret");
    expect(bodyTextFor(letter)).toBe("secret");
  });

  it("终态和异常状态使用可见状态语义", () => {
    expect(isTerminal("DESTROYED")).toBe(true);
    expect(isTerminal("PERMANENTLY_LOST")).toBe(true);
    expect(isTerminal("COURIER_MISSING")).toBe(false);
    expect(statusCopy("LETTER_MISSING")).toBe("位置待确认");
    expect(problemMessage(new LetterApiError("no_station_mapping", 422))).toContain("路线");
  });

  it("搜索限流明确提示等待后重试", () => {
    expect(problemMessage(new LetterApiError("rate_limited", 429))).toBe(
      "操作过于频繁，请稍后再试"
    );
  });
  it("区县或本市驿站不完整时明确提示修改哪一端地址", () => {
    expect(problemMessage(new LetterApiError("origin_region_unavailable", 422))).toContain(
      "你的所在地区"
    );
    expect(problemMessage(new LetterApiError("destination_region_unavailable", 422))).toContain(
      "收件人的地区"
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import type { LetterView } from "../api/letterApi";
import { openReadableLetter, readableLetter } from "./ritual";

describe("拆信门禁", () => {
  const opened = { status: "DELIVERED", readState: "OPENED", content: "正文" } as LetterView;
  it.each([
    { ...opened, readState: "UNOPENED" },
    { ...opened, status: "IN_TRANSIT" },
    { ...opened, content: null },
    { ...opened, decryptionError: "e2ee_key_missing" },
  ])("未授权或无法解密的正文不展开", (letter) => {
    expect(readableLetter(letter as LetterView)).toBe(false);
  });
  it("先提交拆阅，重新获取并确认可读后才返回正文", async () => {
    const calls: string[] = [];
    const api = {
      openLetter: vi.fn(async () => { calls.push("open"); }),
      getLetter: vi.fn(async () => { calls.push("read"); return opened; }),
    };
    await expect(openReadableLetter("YS-TEST", api)).resolves.toBe(opened);
    expect(calls).toEqual(["open", "read"]);
  });
  it("拆阅失败不取正文；解密失败不返回内容", async () => {
    const api = { openLetter: vi.fn().mockRejectedValue(new Error("offline")), getLetter: vi.fn() };
    await expect(openReadableLetter("YS-TEST", api)).rejects.toThrow("offline");
    expect(api.getLetter).not.toHaveBeenCalled();
    api.openLetter.mockResolvedValue(undefined);
    api.getLetter.mockResolvedValue({ ...opened, decryptionError: "e2ee_key_missing" });
    await expect(openReadableLetter("YS-TEST", api)).rejects.toThrow("e2ee_key_missing");
  });
});

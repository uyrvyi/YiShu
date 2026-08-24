import { describe, expect, it } from "vitest";
import type { Letter } from "@yishu/db";
import { toSenderLetterView, toRecipientLetterView, DELIVERED, CREATED } from "./letter-view.js";

function mockLetter(overrides: Partial<Letter> = {}): Letter {
  return {
    id: 1n,
    trackingNo: "YS-20260821-K7P2M8",
    senderId: 1n,
    recipientId: 2n,
    senderAccountSnapshot: "alice",
    senderUidSnapshot: "12345678",
    senderNicknameSnapshot: "Alice",
    recipientAccountSnapshot: "bob",
    recipientUidSnapshot: "87654321",
    recipientNicknameSnapshot: "Bob",
    encryptedContent: "enc",
    contentIv: "iv",
    contentAuthTag: "tag",
    originProvince: "上海市",
    originCity: "上海市",
    originDistrict: "徐汇区",
    targetProvince: "北京市",
    targetCity: "北京市",
    targetDistrict: "海淀区",
    status: CREATED,
    initialTransport: "HORSE_RELAY",
    currentTransport: "HORSE_RELAY",
    clientRequestId: "c1",
    sentAt: new Date(),
    deliveredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Letter;
}

describe("letter views", () => {
  it("Sender 视图不含 readState，始终可见正文", () => {
    const view = toSenderLetterView(mockLetter(), "明文内容");
    expect("readState" in view).toBe(false);
    expect(view.content).toBe("明文内容");
  });

  it("Recipient 未 Delivered 时 content 为 null", () => {
    const view = toRecipientLetterView(mockLetter(), "明文内容");
    expect(view.content).toBeNull();
  });

  it("Recipient DELIVERED 时 content 可见", () => {
    const view = toRecipientLetterView(
      mockLetter({ status: DELIVERED, deliveredAt: new Date() }),
      "明文内容"
    );
    expect(view.content).toBe("明文内容");
  });

  it("Recipient 视图含 readState，且不含 encryptedContent", () => {
    const view = toRecipientLetterView(mockLetter(), "明文内容");
    expect(view.readState).toBe("UNOPENED");
    expect("encryptedContent" in view).toBe(false);
    expect("contentIv" in view).toBe(false);
    expect("contentAuthTag" in view).toBe(false);
  });

  it("视图不含 internal letter id", () => {
    const view = toSenderLetterView(mockLetter(), "明文");
    expect("id" in view).toBe(false);
  });
});

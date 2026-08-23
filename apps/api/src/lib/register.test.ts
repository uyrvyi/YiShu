import { describe, expect, it, vi } from "vitest";
import { createUserWithUidRetry, MAX_UID_RETRY } from "./register.js";

describe("createUserWithUidRetry", () => {
  it("第一次 UID 碰撞、第二次可用 → 注册成功并使用第二个 UID", async () => {
    const candidates = ["11111111", "22222222"];
    const uidGenerator = vi.fn(() => candidates.shift() ?? "99999999");
    const create = vi.fn(async (uid: string) => {
      if (uid === "11111111") return { kind: "collision" as const };
      return { kind: "created" as const, user: { uid } };
    });

    const result = await createUserWithUidRetry({ uidGenerator, maxRetries: 5, create });

    expect(result.kind).toBe("created");
    if (result.kind === "created") {
      const createdUid = result.user?.uid;
      expect(createdUid).toBe("22222222"); // 使用第二个 UID
    }
    expect(uidGenerator).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("连续碰撞直到达到最大重试次数 → 明确失败，不无限循环", async () => {
    const uidGenerator = vi.fn(() => "55555555");
    const create = vi.fn(async () => ({ kind: "collision" as const }));

    const result = await createUserWithUidRetry({
      uidGenerator,
      maxRetries: MAX_UID_RETRY,
      create,
    });

    expect(result.kind).toBe("collision");
    expect(uidGenerator).toHaveBeenCalledTimes(MAX_UID_RETRY);
    expect(create).toHaveBeenCalledTimes(MAX_UID_RETRY); // 不无限循环
  });

  it("account 冲突 → 立即返回，不重试", async () => {
    const uidGenerator = vi.fn(() => "12345678");
    const create = vi.fn(async () => ({ kind: "account_conflict" as const }));

    const result = await createUserWithUidRetry({
      uidGenerator,
      maxRetries: MAX_UID_RETRY,
      create,
    });

    expect(result.kind).toBe("account_conflict");
    expect(create).toHaveBeenCalledTimes(1); // 立即返回，不重试
  });
});

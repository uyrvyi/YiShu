import type { UidGenerator } from "./uid.js";

/** UID 碰撞重试的最大次数（集中定义，不散落 magic number）。 */
export const MAX_UID_RETRY = 10;

/** UID 已存在（碰撞）时的结果。 */
export interface UidCollisionResult {
  kind: "collision";
}

/** 创建成功的结果。 */
export interface UidCreatedResult<T> {
  kind: "created";
  user: T;
}

/** account 已存在（非 UID 冲突）的结果。 */
export interface AccountConflictResult {
  kind: "account_conflict";
}

export type RegisterAttemptResult<T> =
  UidCreatedResult<T> | UidCollisionResult | AccountConflictResult;

export interface CreateUserWithUidRetryOptions<T> {
  /** 生成候选 UID（可注入，默认 generateUid）。 */
  uidGenerator: UidGenerator;
  /** 最大 UID 碰撞重试次数。 */
  maxRetries: number;
  /** 使用给定 uid 创建用户；若 uid 碰撞返回 collision，account 冲突返回 account_conflict。 */
  create: (uid: string) => Promise<RegisterAttemptResult<T>>;
}

/**
 * 使用候选 UID 创建用户，遇 UID 碰撞自动重试。
 *
 * - UID 碰撞：重试（最多 maxRetries 次）。
 * - account 冲突：立即返回 account_conflict（不重试）。
 * - 达到最大重试次数仍失败：返回 collision（调用方决定）。
 */
export async function createUserWithUidRetry<T>(
  opts: CreateUserWithUidRetryOptions<T>
): Promise<RegisterAttemptResult<T>> {
  for (let attempt = 0; attempt < opts.maxRetries; attempt += 1) {
    const uid = opts.uidGenerator();
    const result = await opts.create(uid);
    if (result.kind === "collision") {
      continue;
    }
    return result;
  }
  return { kind: "collision" };
}

import type { TrackingNoGenerator } from "./trackingNo.js";

/** Tracking Number 碰撞重试的最大次数（集中定义）。 */
export const MAX_TRACKING_RETRY = 10;

/** 创建成功的结果。existed=true 表示并发幂等返回已存在 Letter。 */
export interface TrackingCreated<T> {
  kind: "created";
  value: T;
  existed?: boolean;
}

/** Tracking Number 碰撞的结果。 */
export interface TrackingCollision {
  kind: "collision";
}

/** 非 trackingNo 冲突（如业务错误）的结果。 */
export interface TrackingOtherError {
  kind: "error";
}

/** 业务拦截结果（如 Recipient 已拉黑 Sender）。 */
export interface TrackingBlocked {
  kind: "blocked";
}

/** 幂等冲突（同 key 不同 fingerprint）。 */
export interface TrackingConflict {
  kind: "conflict";
}

export type TrackingResult<T> =
  TrackingCreated<T> | TrackingCollision | TrackingOtherError | TrackingBlocked | TrackingConflict;

export interface CreateWithTrackingRetryOptions<T> {
  /** 生成候选 Tracking Number（可注入）。 */
  generator: TrackingNoGenerator;
  /** 最大碰撞重试次数。 */
  maxRetries: number;
  /** 使用给定 trackingNo 创建；碰撞返回 collision。 */
  create: (trackingNo: string) => Promise<TrackingResult<T>>;
}

/**
 * 使用候选 Tracking Number 创建实体，遇碰撞自动重试。
 * - 碰撞：重试（最多 maxRetries 次）。
 * - 其他错误：立即返回 error。
 * - 达到最大重试次数仍碰撞：返回 collision。
 */
export async function createWithTrackingRetry<T>(
  opts: CreateWithTrackingRetryOptions<T>
): Promise<TrackingResult<T>> {
  for (let attempt = 0; attempt < opts.maxRetries; attempt += 1) {
    const trackingNo = opts.generator();
    const result = await opts.create(trackingNo);
    if (result.kind === "collision") {
      continue;
    }
    return result;
  }
  return { kind: "collision" };
}

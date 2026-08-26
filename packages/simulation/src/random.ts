/**
 * 驿书 V1 DeterministicRandom 基础设施（对应开发规范 §62）。
 *
 * 输入：simulationSeed + drawIndex。
 * 相同 seed / index → 相同结果；可重复回放；禁止 `Math.random()`。
 * Phase 5 只建立基础设施；正式随机事件判定在 Phase 6 消费。
 */
import { createHash } from "node:crypto";

/** 由 seed + drawIndex 确定性生成 [0, 1) 区间的伪随机数（SHA-256 前 4 字节 / 2^32）。 */
export function deterministicDraw(seed: string, drawIndex: number): number {
  const digest = createHash("sha256").update(`${seed}:${drawIndex}`).digest();
  return digest.readUInt32BE(0) / 0x100000000;
}

/** 确定性随机数对象：绑定一封 Letter 的 simulationSeed，按 drawIndex 抽取。 */
export class DeterministicRandom {
  constructor(private readonly seed: string) {}

  /** 抽取第 drawIndex 次确定性随机数（[0, 1)）。 */
  draw(drawIndex: number): number {
    return deterministicDraw(this.seed, drawIndex);
  }
}

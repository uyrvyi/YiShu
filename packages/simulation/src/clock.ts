/**
 * 驿书 V1 SimulationClock（对应开发规范 §60）。
 *
 * 运输业务统一使用 `simulationClock.now()` 获取模拟时间，禁止直接使用 `Date.now()`。
 * 生产 `speed = 1`（SystemSimulationClock）；开发可支持加速；测试使用 TestSimulationClock
 * 通过 advanceBy / advanceTo 控制时间，不允许真实 sleep。
 */

/** 统一模拟时钟接口：`now()` 返回当前模拟时间（epoch 毫秒）。 */
export interface SimulationClock {
  now(): number;
}

/**
 * 系统时钟：以真实时间为基准，支持可选加速（speed > 1）。
 * 生产默认 speed = 1（now() === Date.now()）；开发 / Demo 可传入加速倍率。
 */
export class SystemSimulationClock implements SimulationClock {
  private readonly speed: number;
  private readonly epochMs: number;

  constructor(speed = 1, epochMs = Date.now()) {
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new Error("SystemSimulationClock speed must be a positive finite number");
    }
    this.speed = speed;
    this.epochMs = epochMs;
  }

  now(): number {
    return this.epochMs + Math.round((Date.now() - this.epochMs) * this.speed);
  }
}

/** 测试时钟：完全由测试控制，advanceBy / advanceTo 推进，不允许真实 sleep。 */
export class TestSimulationClock implements SimulationClock {
  private currentMs: number;

  constructor(startMs: number) {
    this.currentMs = startMs;
  }

  now(): number {
    return this.currentMs;
  }

  /** 推进相对时长（毫秒）。 */
  advanceBy(ms: number): this {
    this.currentMs += ms;
    return this;
  }

  /** 直接跳到绝对时刻（毫秒）。 */
  advanceTo(ms: number): this {
    this.currentMs = ms;
    return this;
  }
}

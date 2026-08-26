/**
 * 驿书 V1 Simulation 包。
 *
 * Phase 1 建立包骨架；Phase 5 正式实现 SimulationClock 与 DeterministicRandom 基础设施
 * （确定性时间推进核心）。随机事件树等业务在 Phase 6 实现。
 */
export { type SimulationClock, SystemSimulationClock, TestSimulationClock } from "./clock.js";
export { deterministicDraw, DeterministicRandom } from "./random.js";

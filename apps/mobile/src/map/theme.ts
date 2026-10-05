import { C } from "../ui/theme";

/**
 * 地图配色与描边常量（Phase 8 §17 / §18）。
 *
 * 视觉语义（不得随意改变含义）：
 * - completed：实线（已走路线）
 * - remaining：虚线（未走路线）
 * - approximate：当前大概位置（**不是**精确 GPS）
 * - lastKnown：最后确报位置（失联 / 终态时保持不变）
 */
export const MAP_COLORS = {
  water: "#EAF1F4",
  paper: "#F6F8FA",
  outline: "#BCC8D0",
  province: "#DEE5EA",
  completed: C.green,
  remaining: "#94A4AF",
  approximate: C.orange,
  lastKnown: C.muted,
  fact: C.green,
  factHalo: "#FFFFFF",
  /** 起点 / 终点标记（§18 视觉规则：起点 / 终点须可见）。 */
  origin: C.green,
  destination: C.blue,
} as const;

/**
 * 描边宽度（**实际渲染宽度**，即 viewBox 单位；viewBox 固定 0 0 1000 800，不随设备变化）。
 *
 * 底图和路线均已等比拟合到 viewBox，描边无需额外补偿。
 */
export const MAP_STROKE = {
  outline: 2,
  province: 1.2,
  route: 4.5,
} as const;

/** 未走路线虚线样式（§18：未走路线使用虚线）。 */
export const REMAINING_DASH = "12 10";

/** 半径（viewBox 单位；全部为示意性近似标记，无精确 GPS 语义）。 */
export const MAP_RADIUS = {
  approximate: 11,
  approximateHalo: 22,
  lastKnown: 7,
  fact: 8,
} as const;

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
  paper: "#FBF7EF",
  outline: "#C9BFAE",
  province: "#E7E0D3",
  completed: "#8C5A2B",
  remaining: "#B6A78E",
  approximate: "#C2410C",
  lastKnown: "#4B5563",
  fact: "#1F6F5C",
  factHalo: "#FFFFFF",
  /** 起点 / 终点标记（§18 视觉规则：起点 / 终点须可见）。 */
  origin: "#2F6F4E",
  destination: "#7A3E9D",
} as const;

/**
 * 描边宽度（**实际渲染宽度**，即 viewBox 单位；viewBox 固定 0 0 1000 800，不随设备变化）。
 *
 * `outline` / `province` 的几何在 `MAP_FIT_TRANSFORM` 缩放组内渲染，必须经
 * `viewBoxStrokeWidth()` 做 scale 补偿后才能得到这里声明的宽度（Gate L1）；
 * 路线 / 标记的几何已在 JS 侧映射到 viewBox，不需要补偿。
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

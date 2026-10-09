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

export const DARK_MAP_COLORS = {
  water: "#15252D", paper: "#232A2D", outline: "#617782", province: "#46555E",
  completed: "#72D4AE", remaining: "#A0B0BA", approximate: "#E9BD78", lastKnown: "#A7B2BA",
  fact: "#72D4AE", factHalo: "#232A2D", origin: "#72D4AE", destination: "#91BFF1",
};
export const WEB_MAP_PALETTES = {
  light: { ...MAP_COLORS, land: "#FAFCFD", river: "#CEE5EE", coast: "#A4CBDC",
    completed: "#177B65", remaining: "#95A5AF", approximate: "#D18237", origin: "#177B65", destination: "#357AB4", lastKnown: "#177B65",
    road: "#DFE0DD", majorRoad: "#D2D4D1", boundary: "#C0CDD2", provinceBoundary: "#B4C3C9",
    city: ["#F6F9FA", "#F0F5F4", "#F4F6F9"], district: ["#F0F6F4", "#F2F5FA", "#F7F8F9"],
    label: "#71818A", districtLabel: "#89959B", provinceLabel: "#84939C", text: "#202629", panel: "#FFFFFFE6", station: "#687E88" },
  dark: { ...DARK_MAP_COLORS, land: "#232A2D", river: "#294752", coast: "#4D7887",
    road: "#4E5555", majorRoad: "#757C77", boundary: "#60717B", provinceBoundary: "#778C98",
    city: ["#242F30", "#25302B", "#29303A"], district: ["#25342E", "#29343F", "#303436"],
    label: "#C1CDD3", districtLabel: "#B1BDC4", provinceLabel: "#D2DCE2", text: "#F1F4F6", panel: "#1C2023EB", station: "#ACBDC5" },
};

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

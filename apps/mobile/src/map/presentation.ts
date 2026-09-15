/**
 * 地图页面展示层（纯函数，Phase 8 §17 / §70）。
 *
 * 从 `app/letters/[trackingNo]/map.tsx` 抽出，保证页面与测试消费**同一份**展示逻辑：
 * - **时间固定 `Asia/Shanghai`**（开发规范 §70）：不跟随设备时区，任何设备显示同一时刻；
 *   不提供 ETA / 倒计时 / 预计送达（只展示已发生事实与大概位置）。
 * - 只消费服务端用户可见 DTO（`RouteMapViewParsed`），不读任何内部状态。
 */

import type { PublicLetterStatus, RouteMapViewParsed } from "@yishu/shared";

/** 地图事实时间展示时区（规范 §70；固定，不随设备 TZ 变化）。 */
export const MAP_DISPLAY_TIME_ZONE = "Asia/Shanghai";

const FACT_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: MAP_DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * 模拟时间 → `YYYY-MM-DD HH:mm`（固定 Asia/Shanghai）。
 *
 * 禁止使用 `getHours()` / `getDate()` / `getMonth()` 等设备本地方法：不同 TZ 设备会显示不同
 * 日期与时刻（Gate M3）。
 */
export function formatFactTime(iso: string): string {
  const parts = FACT_TIME_FORMATTER.formatToParts(new Date(iso));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

/** 用户可见状态文案（只表达可确认状态，不暴露后台原因）。 */
export const STATUS_LABELS: Record<PublicLetterStatus, string> = {
  CREATED: "待寄出",
  DISPATCHED: "已寄出",
  IN_TRANSIT: "运输中",
  AT_STATION: "在驿站",
  TRANSFER: "转运中",
  DELAYED: "延误",
  COURIER_MISSING: "信使失联",
  LETTER_MISSING: "位置待确认",
  RECOVERED: "运输已恢复",
  TRANSPORT_CHANGED: "寄送方式已变更",
  OUT_FOR_DELIVERY: "派送中",
  DELIVERED: "已送达",
  PERMANENTLY_LOST: "已确认永久遗失",
  DESTROYED: "已损毁",
};

/** 位置说明：只表达「大概 / 最后确报」，不含 ETA / 剩余时间。 */
export function positionNoteFor(view: RouteMapViewParsed): string | null {
  if (view.approximatePosition !== null) return "位置更新中：大概位置（非精确坐标）";
  if (view.lastKnownPosition !== null) return "位置已停止更新：仅显示最后确报位置";
  return null;
}

/** 路线标题（起点 → 终点）。 */
export function routeLabelFor(view: RouteMapViewParsed): string {
  if (view.origin === null || view.destination === null) return "尚未启程";
  return `${view.origin.name} → ${view.destination.name}`;
}

/** 已发生事实行（最新在前；只读展示，不含任何操作入口）。 */
export interface FactRow {
  key: string;
  title: string;
  meta: string;
  description: string;
}

export function factRowsFor(view: RouteMapViewParsed): FactRow[] {
  return view.facts
    .slice()
    .reverse()
    .map((fact, index) => ({
      key: `${fact.type}-${fact.happenedAt}-${String(index)}`,
      title: fact.title,
      meta: `${fact.location.province}${fact.location.city} · ${formatFactTime(fact.happenedAt)}`,
      description: fact.description,
    }));
}

/** 页面底部说明（明确无 ETA）。 */
export const MAP_FOOTNOTE = "只显示可确认的运输事实；不提供预计送达时间，位置为大概位置。";

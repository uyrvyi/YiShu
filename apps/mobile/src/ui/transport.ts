import type { TransportType } from "@yishu/shared";

export const TRANSPORT_DESCRIPTIONS: Record<TransportType, string> = {
  HAND_CARRY: "托付信使沿陆路捎送，节奏较慢，适合不赶时间的信件。",
  HORSE_RELAY: "通过驿站接力换马，沿陆路逐站转递，速度较为适中。",
  EXPRESS_RELAY: "沿驿路加急转递，速度快于普通驿马，适合希望尽早送达的信件。",
  PIGEON: "点对点飞行，不经过陆路驿站；每天按 8 小时飞行计算。",
};

export function formatEstimatedDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "暂不可用";
  if (seconds < 60) return "不到 1 分钟";
  if (seconds >= 86400) {
    const hours = Math.ceil(seconds / 3600);
    const days = Math.floor(hours / 24);
    return `${days} 天${hours % 24 ? ` ${hours % 24} 小时` : ""}`;
  }
  const minutes = Math.ceil(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}` : `${minutes} 分钟`;
}

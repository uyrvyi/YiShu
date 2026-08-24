/**
 * 地理计算工具（Phase 4：PIGEON 直线距离）。
 *
 * 完全本地，不依赖任何外部地图服务。
 */

const EARTH_RADIUS_KM = 6371;

/** 角度转弧度。 */
function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Haversine 大圆距离（km）。
 * 用于 PIGEON 点对点直线距离（开发规范 §26，不走 road graph）。
 */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

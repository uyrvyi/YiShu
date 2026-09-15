/**
 * RouteMap 图层组件（开发规范 §17 组件结构 + §18 视觉规则）。
 *
 * ```text
 * RouteMap
 * ├─ ChinaOutlineLayer
 * ├─ ProvinceBoundaryLayer
 * ├─ CompletedRouteLayer     （实线）
 * ├─ RemainingRouteLayer     （虚线）
 * ├─ ApproximatePositionLayer（当前大概位置；非精确 GPS）
 * ├─ LastKnownPositionLayer  （最后确报位置）
 * └─ FactNodeLayer           （已发生事实节点）
 * ```
 *
 * 全部使用 `react-native-svg` 在固定 viewBox 内渲染，**完全离线**：
 * 不请求任何在线地图 / 瓦片 / geocoder，不渲染任何掉落范围（`LETTER_DROPPED` 全局 HIDDEN）。
 */

import { Circle, G, Path, Polyline } from "react-native-svg";
import type { MapFactView, MapPoint } from "@yishu/shared";
import { CHINA_MAP_OUTLINE_D, CHINA_PROVINCE_SHAPES } from "./chinaMapData";
import {
  MAP_FIT_TRANSFORM,
  toPolylinePoints,
  toViewBoxPoint,
  viewBoxStrokeWidth,
} from "./geometry";
import { MAP_COLORS, MAP_RADIUS, MAP_STROKE, REMAINING_DASH } from "./theme";

/**
 * 中国外轮廓（静态本地资产，示意性几何）。
 *
 * 资产 `path d` 位于 `mapX/mapY` 坐标系 → 必须放进 `MAP_FIT_TRANSFORM` 缩放组；
 * 描边宽度经 `viewBoxStrokeWidth()` 补偿，保证实际渲染宽度 = `MAP_STROKE.outline`（Gate L1）。
 */
export function ChinaOutlineLayer() {
  return (
    <G transform={MAP_FIT_TRANSFORM}>
      <Path
        id="china-outline"
        d={CHINA_MAP_OUTLINE_D}
        fill="none"
        stroke={MAP_COLORS.outline}
        strokeWidth={viewBoxStrokeWidth(MAP_STROKE.outline)}
        strokeLinejoin="round"
      />
    </G>
  );
}

/**
 * ADM1 行政单元边界（vendored geoBoundaries `gbOpen / CHN / ADM1`，34 个 feature）。
 *
 * 几何直接来自源数据（仅 canonical projection + 序列化：无简化 / 无外扩 / 无凸包 / 无六边形），
 * 与 `ChinaOutlineLayer` 同源 → 省形不会越出国家轮廓；MultiPolygon / 岛屿全部保留。
 * 来源、许可与「非法律边界认定」说明见 `data/maps/README.md`；运行时完全离线。
 */
export function ProvinceBoundaryLayer() {
  return (
    <G transform={MAP_FIT_TRANSFORM}>
      {CHINA_PROVINCE_SHAPES.map((shape) => (
        <Path
          key={shape.id}
          id={shape.id}
          d={shape.d}
          fill="none"
          stroke={MAP_COLORS.province}
          strokeWidth={viewBoxStrokeWidth(MAP_STROKE.province)}
        />
      ))}
    </G>
  );
}

/** 已走路线：实线（只由用户可见事实确认的节点组成）。 */
export function CompletedRouteLayer({ points }: { points: readonly MapPoint[] }) {
  if (points.length < 2) return null;
  return (
    <Polyline
      id="completed-route"
      points={toPolylinePoints(points)}
      fill="none"
      stroke={MAP_COLORS.completed}
      strokeWidth={MAP_STROKE.route}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

/** 未走路线：虚线（来自冻结的路线规划几何）。 */
export function RemainingRouteLayer({ points }: { points: readonly MapPoint[] }) {
  if (points.length < 2) return null;
  return (
    <Polyline
      id="remaining-route"
      points={toPolylinePoints(points)}
      fill="none"
      stroke={MAP_COLORS.remaining}
      strokeWidth={MAP_STROKE.route}
      strokeDasharray={REMAINING_DASH}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

/**
 * 当前大概位置：位置标记 + 外圈光晕（明确表达"大概"，不是精确 GPS 点）。
 * 失联 / 终态 / 无时间锚点时由上层传 `null` → 不渲染（只保留最后确报位置）。
 */
export function ApproximatePositionLayer({ position }: { position: MapPoint | null }) {
  if (position === null) return null;
  const { x, y } = toViewBoxPoint(position);
  return (
    <G id="approximate-position">
      <Circle
        cx={x}
        cy={y}
        r={MAP_RADIUS.approximateHalo}
        fill={MAP_COLORS.approximate}
        fillOpacity={0.16}
      />
      <Circle
        cx={x}
        cy={y}
        r={MAP_RADIUS.approximate}
        fill={MAP_COLORS.paper}
        stroke={MAP_COLORS.approximate}
        strokeWidth={3}
      />
    </G>
  );
}

/** 最后确报位置（失联 / 终态时保持不变）。 */
export function LastKnownPositionLayer({ position }: { position: MapPoint | null }) {
  if (position === null) return null;
  const { x, y } = toViewBoxPoint(position);
  return (
    <Circle
      id="last-known-position"
      cx={x}
      cy={y}
      r={MAP_RADIUS.lastKnown}
      fill={MAP_COLORS.lastKnown}
      stroke={MAP_COLORS.paper}
      strokeWidth={2}
    />
  );
}

/**
 * 已发生事实节点：只来自用户可见 Timeline（最多 5 个高优先事实）。
 * 不渲染文字标签（避免小屏重叠），事实文案由地图下方列表展示。
 */
export function FactNodeLayer({ facts }: { facts: readonly MapFactView[] }) {
  return (
    <G id="fact-nodes">
      {facts.map((fact, index) => {
        const { x, y } = toViewBoxPoint({ x: fact.x, y: fact.y });
        return (
          <Circle
            key={`${fact.type}-${fact.happenedAt}-${String(index)}`}
            cx={x}
            cy={y}
            r={MAP_RADIUS.fact}
            fill={MAP_COLORS.fact}
            stroke={MAP_COLORS.factHalo}
            strokeWidth={2}
          />
        );
      })}
    </G>
  );
}

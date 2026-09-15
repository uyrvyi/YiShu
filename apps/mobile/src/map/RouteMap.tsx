/**
 * RouteMap（开发规范 §17 / §18 / §74；阶段规划 Phase 8）。
 *
 * - 固定 `viewBox="0 0 1000 800"`（`@yishu/shared` 的 `MAP_VIEWBOX`），不随设备变化。
 * - 完全本地静态：`chinaMapData.ts`（由 `data/gen_map.cjs` 离线生成）+ `react-native-svg`；
 *   无在线地图 / 瓦片 / geocoder，无 exact GPS。
 * - 只渲染服务端返回的用户可见 DTO：已走实线 / 未走虚线 / 大概位置 / 最后确报 / 事实节点。
 *   不渲染 ETA、倒计时，不渲染任何掉落范围（`LETTER_DROPPED` 全局 HIDDEN）。
 *
 * 图层顺序即 z-order（见 `layers.tsx`）；起点 / 终点标记是 §18 视觉规则的一部分，不是数据图层。
 */

import { StyleSheet, View } from "react-native";
import Svg, { Circle, Rect } from "react-native-svg";
import type { RouteMapViewParsed } from "@yishu/shared";
import {
  ApproximatePositionLayer,
  ChinaOutlineLayer,
  CompletedRouteLayer,
  FactNodeLayer,
  LastKnownPositionLayer,
  ProvinceBoundaryLayer,
  RemainingRouteLayer,
} from "./layers";
import { MAP_VIEWBOX_STRING, toViewBoxPoint } from "./geometry";
import { MAP_COLORS, MAP_RADIUS } from "./theme";

interface RouteMapProps {
  /** `GET /letters/:trackingNo/map` 的用户可见响应（已经 schema strip-parse）。 */
  view: RouteMapViewParsed;
}

export function RouteMap({ view }: RouteMapProps) {
  const origin = view.origin === null ? null : toViewBoxPoint(view.origin);
  const destination = view.destination === null ? null : toViewBoxPoint(view.destination);

  return (
    <View style={styles.container} accessibilityLabel="信件旅程地图">
      <Svg
        width="100%"
        height="100%"
        viewBox={MAP_VIEWBOX_STRING}
        preserveAspectRatio="xMidYMid meet"
      >
        <Rect x={0} y={0} width="100%" height="100%" fill={MAP_COLORS.paper} />
        <ChinaOutlineLayer />
        <ProvinceBoundaryLayer />
        <RemainingRouteLayer points={view.remainingPath} />
        <CompletedRouteLayer points={view.completedPath} />
        {origin === null ? null : (
          <Circle
            id="origin-marker"
            cx={origin.x}
            cy={origin.y}
            r={MAP_RADIUS.fact}
            fill={MAP_COLORS.paper}
            stroke={MAP_COLORS.origin}
            strokeWidth={3}
          />
        )}
        {destination === null ? null : (
          <Circle
            id="destination-marker"
            cx={destination.x}
            cy={destination.y}
            r={MAP_RADIUS.fact}
            fill={MAP_COLORS.paper}
            stroke={MAP_COLORS.destination}
            strokeWidth={3}
          />
        )}
        <FactNodeLayer facts={view.facts} />
        <LastKnownPositionLayer position={view.lastKnownPosition} />
        <ApproximatePositionLayer position={view.approximatePosition} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    aspectRatio: 5 / 4, // 与固定 viewBox 1000x800 一致
    width: "100%",
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#E3DACB",
  },
});

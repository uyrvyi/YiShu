import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import type { RouteMapViewParsed } from "@yishu/shared";
import { RouteMap } from "../../../src/map/RouteMap";
import { FactList } from "../../../src/map/FactList";
import {
  MAP_FOOTNOTE,
  STATUS_LABELS,
  positionNoteFor,
  routeLabelFor,
} from "../../../src/map/presentation";

/**
 * 信件旅程地图（Phase 8 §17 / §18 / §74）。
 *
 * - 已走路线实线 / 未走路线虚线 / 当前大概位置 / 最后确报位置 / 已发生事实节点。
 * - 只展示服务端用户可见 DTO；无 ETA、无倒计时、无精确 GPS、无掉落范围。
 * - 事实时间固定 `Asia/Shanghai`（§70，`src/map/presentation.ts`），不随设备时区变化。
 * - 地图为完全本地静态资产（`react-native-svg` + 离线生成的 `chinaMapData.ts`）。
 */
export default function LetterMapScreen() {
  const { trackingNo } = useLocalSearchParams<{ trackingNo: string }>();
  const [view, setView] = useState<RouteMapViewParsed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const { getApi } = await import("../../../src/api/index");
        setView(await getApi().getRouteMap(trackingNo));
      } catch (e) {
        setError((e as Error).message);
      }
    }
    void load();
  }, [trackingNo]);

  if (error) {
    return <Text style={styles.error}>{error}</Text>;
  }
  if (!view) {
    return <Text style={styles.loading}>加载中...</Text>;
  }

  const positionNote = positionNoteFor(view);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>旅程地图</Text>
      <Text style={styles.status}>状态：{STATUS_LABELS[view.status]}</Text>
      <Text style={styles.route}>{routeLabelFor(view)}</Text>

      <RouteMap view={view} />

      <View style={styles.legend}>
        <Text style={styles.legendItem}>━━ 已走路线</Text>
        <Text style={styles.legendItem}>- - 未走路线</Text>
        <Text style={styles.legendItem}>◉ 大概位置</Text>
        <Text style={styles.legendItem}>● 最后确报</Text>
        <Text style={styles.legendItem}>• 已发生事实</Text>
      </View>

      {positionNote ? <Text style={styles.positionNote}>{positionNote}</Text> : null}

      <FactList view={view} />

      <Text style={styles.note}>{MAP_FOOTNOTE}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16 },
  loading: { flex: 1, textAlign: "center", marginTop: 24 },
  error: { color: "red", padding: 16 },
  title: { fontSize: 20, fontWeight: "600", marginBottom: 8 },
  status: { marginBottom: 4 },
  route: { color: "#444", marginBottom: 12 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 12 },
  legendItem: { color: "#666", fontSize: 12 },
  positionNote: { marginTop: 12, color: "#333" },
  note: { marginTop: 16, color: "#888", fontSize: 12 },
});

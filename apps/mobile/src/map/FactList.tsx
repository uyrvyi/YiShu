/**
 * 已发生事实列表（只读；Phase 8 §17 / §18）。
 *
 * - 只渲染服务端用户可见 DTO 派生的事实行（`factRowsFor`，时间固定 Asia/Shanghai）。
 * - **只读**：没有任何按钮 / 可点击操作 / 跳转（用户不能改变路线或位置）。
 */

import { Text, View } from "react-native";
import type { RouteMapViewParsed } from "@yishu/shared";
import { factRowsFor } from "./presentation";

export function FactList({ view }: { view: RouteMapViewParsed }) {
  const rows = factRowsFor(view);

  return (
    <View style={styles.factsBox}>
      <Text style={styles.factsTitle}>已发生事实</Text>
      {rows.length === 0 ? (
        <Text style={styles.factMeta}>暂无可确认事实</Text>
      ) : (
        rows.map((row) => (
          <View key={row.key} style={styles.factRow}>
            <Text style={styles.factTitle}>{row.title}</Text>
            <Text style={styles.factMeta}>{row.meta}</Text>
            <Text style={styles.factMeta}>{row.description}</Text>
          </View>
        ))
      )}
    </View>
  );
}

const styles = {
  factsBox: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
  },
  factsTitle: { fontWeight: "600", marginBottom: 8 },
  factRow: { marginBottom: 10 },
  factTitle: { fontWeight: "500" },
  factMeta: { color: "#666", fontSize: 12 },
} as const;

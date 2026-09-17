import { useCallback } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Link, useLocalSearchParams } from "expo-router";
import { usePolling } from "../../src/refresh/usePolling";
import { DETAIL_POLL_MS } from "../../src/refresh/poller";

/** 信件详情（Phase 3 最小真实流程）。
 * Recipient 在 DELIVERED 前看到锁定正文（content 由服务端置 null，此处展示锁定状态）。
 */
export default function LetterDetailScreen() {
  const { trackingNo } = useLocalSearchParams<{ trackingNo: string }>();
  const load = useCallback(async () => {
    const { getApi } = await import("../../src/api/index");
    // Fetch safe facts too; full Timeline UI remains Phase 10.
    const [letter] = await Promise.all([
      getApi().getLetter(trackingNo),
      getApi().getTimeline(trackingNo),
    ]);
    return letter;
  }, [trackingNo]);
  const { data: letter, error } = usePolling(load, DETAIL_POLL_MS);

  if (error) {
    return <Text style={styles.error}>{error}</Text>;
  }
  if (!letter) {
    return <Text>加载中...</Text>;
  }

  const locked = letter.content === null && letter.status !== "DELIVERED";

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{letter.trackingNo}</Text>
      {letter.journey ? (
        <Link href={`/letters/${trackingNo}/map`} style={styles.mapLink}>
          <Text>查看旅程地图</Text>
        </Link>
      ) : null}
      <Text>状态：{letter.status}</Text>
      <Text>运输方式：{letter.currentTransport}</Text>
      <Text>
        {letter.origin.province} → {letter.target.province}
      </Text>
      <Text>发件人：{letter.sender.nickname}</Text>
      <Text>收件人：{letter.recipient.nickname}</Text>
      {letter.journey ? (
        <View style={styles.contentBox}>
          <Text style={styles.contentLabel}>运输路线</Text>
          <Text>
            {letter.journey.origin.name} → {letter.journey.destination.name}
          </Text>
          <Text>总里程：{Math.round(letter.journey.totalDistanceKm)} km</Text>
          {letter.journey.legs.map((leg) => (
            <Text key={leg.sequence}>
              {leg.from.name} → {leg.to.name}（{leg.transportType} · {Math.round(leg.distanceKm)}
              km）
            </Text>
          ))}
        </View>
      ) : null}
      <View style={styles.contentBox}>
        <Text style={styles.contentLabel}>正文</Text>
        {locked ? <Text>🔒 已送达后方可查看</Text> : <Text>{letter.content}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", padding: 16 },
  title: { fontSize: 18, fontWeight: "600", marginBottom: 8 },
  mapLink: { color: "#1a73e8", marginBottom: 8 },
  contentBox: { marginTop: 16, borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12 },
  contentLabel: { fontWeight: "600", marginBottom: 4 },
  error: { color: "red", padding: 16 },
});

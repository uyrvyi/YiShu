import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Link } from "expo-router";
import type { LetterView } from "../../src/api/letterApi";

/**
 * 我的信件列表（Phase 3 最小真实流程）。
 * 展示寄出/收到的信件；正文在 Recipient DELIVERED 前锁定（由服务端控制，此处不展示 content）。
 */
export default function LettersScreen() {
  const [letters, setLetters] = useState<LetterView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      // 通过共享 API 客户端拉取（token 由注入来源提供）
      const { getApi } = await import("../../src/api/index");
      const api = getApi();
      const list = await api.listLetters();
      setLetters(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>我的信件</Text>
      <Link href="/letters/new" style={styles.composeLink}>
        <Text>写信</Text>
      </Link>
      {loading ? <Text>加载中...</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        data={letters}
        keyExtractor={(item) => item.trackingNo}
        renderItem={({ item }) => (
          <Link href={`/letters/${item.trackingNo}`} asChild>
            <Pressable style={styles.card}>
              <Text style={styles.trackingNo}>{item.trackingNo}</Text>
              <Text>状态：{item.status}</Text>
              <Text>方式：{item.currentTransport}</Text>
            </Pressable>
          </Link>
        )}
        ListEmptyComponent={!loading && !error ? <Text>暂无信件</Text> : null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", padding: 16 },
  title: { fontSize: 20, fontWeight: "600", marginBottom: 8 },
  composeLink: { marginBottom: 12, color: "#1a73e8" },
  card: { padding: 12, borderWidth: 1, borderColor: "#ddd", borderRadius: 8, marginBottom: 8 },
  trackingNo: { fontWeight: "600" },
  error: { color: "red", marginBottom: 8 },
});

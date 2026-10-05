import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  PackageSearch,
  Search,
  X,
} from "lucide-react-native";
import type { LetterView } from "../../src/api/letterApi";
import { getApi } from "../../src/api";
import { formatFactTime } from "../../src/map/presentation";
import { HOME_POLL_MS } from "../../src/refresh/poller";
import { usePolling } from "../../src/refresh/usePolling";
import { BottomNav, useBottomNavContentInset } from "../../src/ui/BottomNav";
import { Notice } from "../../src/ui/controls";
import { isTerminal, statusCopy, statusTone, TRANSPORT_LABELS } from "../../src/ui/presentation";
import { C, UI } from "../../src/ui/theme";

type Filter = "all" | "sent" | "received";
type Row = { letter: LetterView; direction: "sent" | "received" };

export default function LettersScreen() {
  const bottomInset = useBottomNavContentInset();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    const [sent, received] = await Promise.all([
      getApi().listLetters("sent"),
      getApi().listLetters("received"),
    ]);
    return { sent, received };
  }, []);
  const { data, error, refresh } = usePolling(load, HOME_POLL_MS);

  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const [direction, letters] of [
    ["received", data?.received ?? []],
    ["sent", data?.sent ?? []],
  ] as const) {
    if (filter !== "all" && filter !== direction) continue;
    for (const letter of letters) {
      if (!seen.has(letter.trackingNo)) rows.push({ letter, direction });
      seen.add(letter.trackingNo);
    }
  }
  const term = query.trim().toLowerCase();
  const visible = rows
    .filter(({ letter, direction }) => {
      if (!term) return true;
      const peer = direction === "sent" ? letter.recipient : letter.sender;
      return [letter.trackingNo, peer.nickname, peer.account, peer.uid].some((value) =>
        value.toLowerCase().includes(term)
      );
    })
    .sort((a, b) => b.letter.createdAt.localeCompare(a.letter.createdAt));
  const inTransit = data
    ? new Set(
        [...data.sent, ...data.received]
          .filter((letter) => !isTerminal(letter.status))
          .map((letter) => letter.trackingNo)
      ).size
    : null;

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safe}>
      <FlatList
        contentContainerStyle={[styles.list, { paddingBottom: bottomInset }]}
        data={visible}
        keyExtractor={(row) => row.letter.trackingNo}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={C.green}
            onRefresh={() => {
              setRefreshing(true);
              void refresh().finally(() => setRefreshing(false));
            }}
          />
        }
        ListHeaderComponent={
          <>
            <View style={styles.header}>
              <View>
                <Text accessibilityRole="header" style={styles.title}>
                  驿书
                </Text>
                <Text style={styles.brand}>我的信件</Text>
              </View>
              {inTransit !== null ? (
                <View style={styles.inTransit}>
                  <View style={styles.liveDot} />
                  <Text style={styles.inTransitText}>在途 {inTransit}</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.search}>
              <Search size={19} color={C.muted} />
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="运单号或联系人"
                placeholderTextColor={C.muted}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="搜索信件"
              />
              {query ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="清除搜索"
                  style={styles.clearSearch}
                  onPress={() => setQuery("")}
                >
                  <X size={17} color={C.muted} />
                </Pressable>
              ) : null}
            </View>
            <View style={styles.filters}>
              {(
                [
                  ["all", "全部"],
                  ["received", "我收到的"],
                  ["sent", "我寄出的"],
                ] as const
              ).map(([key, label]) => (
                <Pressable
                  key={key}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: filter === key }}
                  onPress={() => setFilter(key)}
                  style={({ pressed }) => [
                    styles.filter,
                    filter === key && styles.filterActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.filterText, filter === key && styles.filterTextActive]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            {error ? (
              <View style={styles.error}>
                <Notice>信件暂时无法更新，请下拉重试</Notice>
              </View>
            ) : null}
            {!data && !error ? <ActivityIndicator color={C.green} style={styles.loading} /> : null}
          </>
        }
        ListEmptyComponent={
          data ? (
            <View style={styles.empty}>
              <PackageSearch size={30} color={C.muted} />
              <Text style={styles.emptyText}>{term ? "没有找到匹配的信件" : "这里还没有信件"}</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const peer = item.direction === "sent" ? item.letter.recipient : item.letter.sender;
          const DirectionIcon = item.direction === "sent" ? ArrowUpRight : ArrowDownLeft;
          return (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`${peer.nickname}，${statusCopy(item.letter.status)}`}
              onPress={() => router.push(`/letters/${item.letter.trackingNo}`)}
            >
              <View style={styles.rowTop}>
                <View style={styles.peer}>
                  <View
                    style={[
                      styles.direction,
                      item.direction === "received" && styles.directionReceived,
                    ]}
                  >
                    <DirectionIcon
                      size={20}
                      strokeWidth={1.8}
                      color={item.direction === "sent" ? C.green : C.blue}
                    />
                  </View>
                  <View style={styles.peerText}>
                    <Text style={styles.peerName} numberOfLines={1}>
                      {peer.nickname}
                    </Text>
                    <Text style={styles.directionLabel}>
                      {item.direction === "sent" ? "寄给" : "来自"}
                    </Text>
                  </View>
                </View>
                <Text
                  style={[styles.status, { color: C[statusTone(item.letter.status)] }]}
                  numberOfLines={2}
                >
                  {statusCopy(item.letter.status)}
                </Text>
              </View>
              <View style={styles.route}>
                <Text style={styles.city} numberOfLines={1}>
                  {item.letter.origin.city}
                </Text>
                <ArrowRight size={16} color={C.muted} strokeWidth={1.5} />
                <Text style={styles.city} numberOfLines={1}>
                  {item.letter.target.city}
                </Text>
              </View>
              <View style={styles.rowBottom}>
                <Text style={styles.meta} numberOfLines={1}>
                  {TRANSPORT_LABELS[item.letter.currentTransport]} ·{" "}
                  {formatFactTime(item.letter.createdAt)}
                </Text>
                <ChevronRight size={17} color={C.muted} />
              </View>
            </Pressable>
          );
        }}
      />
      <BottomNav active="letters" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.canvas },
  list: {
    flexGrow: 1,
    paddingHorizontal: UI.gutter,
    paddingBottom: 28,
    width: "100%",
    maxWidth: 680,
    alignSelf: "center",
  },
  header: {
    paddingTop: 24,
    paddingBottom: 28,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  brand: { color: C.muted, fontSize: 14, marginTop: 7 },
  title: { color: C.ink, fontSize: 28, fontWeight: "700" },
  inTransit: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 4,
    marginBottom: 3,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.green },
  inTransitText: { color: C.green, fontSize: 13, fontWeight: "600" },
  search: {
    backgroundColor: C.surface,
    borderRadius: UI.radius,
    minHeight: UI.controlHeight,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    gap: 10,
  },
  searchInput: { flex: 1, minWidth: 0, color: C.ink, fontSize: 15, paddingVertical: 12 },
  clearSearch: { width: 32, height: 44, alignItems: "center", justifyContent: "center" },
  filters: {
    flexDirection: "row",
    backgroundColor: "#E9EDF0",
    borderRadius: UI.radius,
    padding: 4,
    gap: 4,
    marginTop: 20,
    marginBottom: 20,
  },
  filter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    paddingVertical: 9,
    borderRadius: UI.segmentRadius,
  },
  filterActive: { backgroundColor: C.surface },
  filterText: { fontSize: 13, color: C.muted, fontWeight: "500", textAlign: "center" },
  filterTextActive: { color: C.ink, fontWeight: "600" },
  row: {
    backgroundColor: C.surface,
    borderRadius: UI.radius,
    padding: 20,
    marginBottom: 12,
    minHeight: 156,
  },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  peer: { flexDirection: "row", alignItems: "center", gap: 11, flex: 1, minWidth: 0 },
  direction: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.greenSoft,
  },
  directionReceived: { backgroundColor: C.blueSoft },
  peerText: { flex: 1, minWidth: 0 },
  peerName: { fontSize: 16, fontWeight: "600", color: C.ink },
  directionLabel: { fontSize: 11, color: C.muted, marginTop: 3 },
  status: {
    fontSize: 12,
    fontWeight: "600",
    flexShrink: 1,
    maxWidth: "40%",
    textAlign: "right",
    lineHeight: 18,
  },
  route: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 19 },
  city: { color: C.ink, fontSize: 16, fontWeight: "500", flexShrink: 1 },
  rowBottom: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 16,
    gap: 8,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  meta: { color: C.muted, fontSize: 12, flex: 1 },
  error: { marginBottom: 12 },
  loading: { marginTop: 30 },
  empty: { alignItems: "center", gap: 10, marginTop: 64 },
  emptyText: { color: C.muted, fontSize: 14 },
  pressed: { opacity: UI.pressedOpacity },
});

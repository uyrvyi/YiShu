import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { getApi } from "../../../src/api";
import { AuthExpiredError } from "../../../src/api/authenticatedFetch";
import { InteractiveRouteMap } from "../../../src/map/InteractiveRouteMap";
import { formatFactTime, positionNoteFor, routeLabelFor } from "../../../src/map/presentation";
import { DETAIL_POLL_MS } from "../../../src/refresh/poller";
import { usePolling } from "../../../src/refresh/usePolling";
import { ActionButton, Notice, ScreenHeader } from "../../../src/ui/controls";
import { problemMessage, statusCopy, statusTone } from "../../../src/ui/presentation";
import { type Colors, UI } from "../../../src/ui/theme";
import { useAppTheme, useThemedStyles } from "../../../src/ui/ThemeProvider";
import { MAP_COLORS } from "../../../src/map/theme";
import { formatEstimatedDuration } from "../../../src/ui/transport";

const INITIAL_FACTS = 3;

export default function LogisticsScreen() {
  const { colors: C } = useAppTheme();
  const styles = useThemedStyles(createStyles);

  const { trackingNo } = useLocalSearchParams<{ trackingNo: string }>();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mapInteracting, setMapInteracting] = useState(false);
  const pageScroll = useRef<ScrollView>(null);
  const handleMapInteraction = useCallback((active: boolean) => {
    pageScroll.current?.setNativeProps({ scrollEnabled: !active });
    setMapInteracting(active);
  }, []);
  const loadDetail = useCallback(async () => {
    try {
      const [letter, timeline] = await Promise.all([
        getApi().getLetter(trackingNo),
        getApi().getTimeline(trackingNo),
      ]);
      const estimate =
        letter.readState === undefined
          ? await getApi()
              .getNextStationEstimate(trackingNo)
              .catch((failure: unknown) => {
                if (failure instanceof AuthExpiredError) throw failure;
                return null;
              })
          : null;
      return { letter, timeline, estimate };
    } catch (failure) {
      if (failure instanceof AuthExpiredError) router.replace("/");
      throw failure;
    }
  }, [trackingNo]);
  const loadMap = useCallback(() => getApi().getRouteMap(trackingNo), [trackingNo]);
  const { data, error, refresh } = usePolling(loadDetail, DETAIL_POLL_MS);
  const {
    data: mapView,
    error: mapError,
    refresh: refreshMap,
  } = usePolling(loadMap, DETAIL_POLL_MS);
  const facts = data?.timeline.slice().reverse() ?? [];
  const visibleFacts = expanded ? facts : facts.slice(0, INITIAL_FACTS);
  const progress =
    data?.letter.readState === undefined &&
    data?.estimate?.state === "ON_THE_WAY" &&
    data.estimate.remainingSeconds !== null
      ? {
          title: "在路上",
          detail: `预计还有 ${formatEstimatedDuration(data.estimate.remainingSeconds)} 到下一站`,
        }
      : data?.letter.readState === undefined && data?.letter.status === "IN_TRANSIT"
        ? { title: "在路上", detail: "预计时间更新中" }
        : undefined;

  async function retryJourney() {
    if (busy) return;
    setBusy(true);
    try {
      await getApi().initializeJourney(trackingNo);
      await Promise.all([refresh(), refreshMap()]);
    } catch (failure) {
      if (failure instanceof AuthExpiredError) router.replace("/");
      else Alert.alert("路线未建立", problemMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        ref={pageScroll}
        scrollEnabled={!mapInteracting}
        contentContainerStyle={styles.page}
      >
        <ScreenHeader
          title="物流详情"
          backLabel="返回信件详情"
          onBack={() =>
            router.canGoBack() ? router.back() : router.replace(`/letters/${trackingNo}`)
          }
        />
        {error ? <Notice>物流信息暂时无法更新，请稍后重试</Notice> : null}
        {!data ? <ActivityIndicator color={C.green} style={styles.loading} /> : null}
        {data ? (
          <>
            <View style={styles.summary}>
              <Text style={[styles.status, { color: C[statusTone(data.letter.status)] }]}>
                {mapView?.collection?.state === "IN_PROGRESS"
                  ? "运输中"
                  : statusCopy(data.letter.status)}
              </Text>
              <Text style={styles.route} numberOfLines={2}>
                {mapView
                  ? routeLabelFor(mapView)
                  : `${data.letter.origin.city} → ${data.letter.target.city}`}
              </Text>
              <Text style={styles.tracking}>运单号 {data.letter.trackingNo}</Text>
            </View>
            {data.letter.status === "COURIER_MISSING" || data.letter.status === "LETTER_MISSING" ? (
              <Notice tone="info">当前位置暂时无法确认，后续消息会在这里更新。</Notice>
            ) : null}
            {data.letter.status === "CREATED" && data.letter.readState === undefined ? (
              <View style={styles.retry}>
                <Notice tone="info">路线尚未建立。</Notice>
                <ActionButton
                  title={busy ? "正在重试…" : "重试建立路线"}
                  quiet
                  disabled={busy}
                  onPress={() => void retryJourney()}
                />
              </View>
            ) : null}

            <View style={styles.section}>
              <Text accessibilityRole="header" style={styles.heading}>
                运输地图
              </Text>
              {mapError ? <Notice>地图暂时无法更新，请稍后重试</Notice> : null}
              {mapView ? (
                <>
                  <InteractiveRouteMap
                    view={mapView}
                    progress={progress}
                    onInteractionChange={handleMapInteraction}
                  />
                  <View style={styles.legend}>
                    <View style={styles.legendItem}>
                      <View style={[styles.legendLine, { borderColor: MAP_COLORS.completed }]} />
                      <Text style={styles.legendText}>已确认轨迹</Text>
                    </View>
                    {mapView.remainingPath.length > 0 ? (
                      <View style={styles.legendItem}>
                        <View
                          style={[
                            styles.legendLine,
                            { borderColor: MAP_COLORS.remaining, borderStyle: "dashed" },
                          ]}
                        />
                        <Text style={styles.legendText}>计划路段</Text>
                      </View>
                    ) : null}
                    {mapView.lastKnownPosition ? (
                      <View style={styles.legendItem}>
                        <View style={styles.legendDot} />
                        <Text style={styles.legendText}>最后确认位置</Text>
                      </View>
                    ) : null}
                  </View>
                  {positionNoteFor(mapView) ? (
                    <Text style={styles.positionNote}>{positionNoteFor(mapView)}</Text>
                  ) : null}
                </>
              ) : !mapError ? (
                <ActivityIndicator color={C.green} style={styles.mapLoading} />
              ) : null}
            </View>

            <View style={styles.section}>
              <Text accessibilityRole="header" style={styles.heading}>
                运输动态
              </Text>
              {visibleFacts.length ? (
                visibleFacts.map((fact, index) => (
                  <View style={styles.fact} key={`${fact.type}-${fact.happenedAt}-${index}`}>
                    <View style={styles.factRail}>
                      <View style={[styles.factDot, index === 0 && styles.factDotActive]} />
                      {index < visibleFacts.length - 1 ? <View style={styles.factLine} /> : null}
                    </View>
                    <View style={styles.factBody}>
                      <Text style={[styles.factTitle, index === 0 && styles.factTitleActive]}>
                        {fact.title}
                      </Text>
                      <Text style={styles.factMeta}>
                        {fact.location.province} {fact.location.city} ·{" "}
                        {formatFactTime(fact.happenedAt)}
                      </Text>
                      {fact.description ? (
                        <Text style={styles.factDescription}>{fact.description}</Text>
                      ) : null}
                    </View>
                  </View>
                ))
              ) : (
                <Text style={styles.empty}>暂无运输动态</Text>
              )}
              {facts.length > INITIAL_FACTS ? (
                <Pressable
                  style={({ pressed }) => [styles.expand, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={expanded ? "收起运输动态" : "查看全部运输动态"}
                  accessibilityState={{ expanded }}
                  onPress={() => setExpanded((value) => !value)}
                >
                  <Text style={styles.expandText}>
                    {expanded ? "收起" : `查看全部 ${facts.length} 条动态`}
                  </Text>
                  {expanded ? (
                    <ChevronUp size={17} color={C.green} />
                  ) : (
                    <ChevronDown size={17} color={C.green} />
                  )}
                </Pressable>
              ) : null}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (C: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.surface },
  page: {
    width: "100%",
    maxWidth: 680,
    alignSelf: "center",
    paddingHorizontal: UI.gutter,
    paddingBottom: 48,
  },
  loading: { marginTop: 36 },
  summary: { paddingTop: 24, paddingBottom: 30 },
  status: { fontSize: 26, fontWeight: "600" },
  route: { color: C.ink, fontSize: 17, fontWeight: "500", marginTop: 12, lineHeight: 26 },
  tracking: { color: C.muted, fontSize: 12, marginTop: 10, lineHeight: 18 },
  retry: { gap: 10, marginBottom: 12 },
  section: {
    paddingTop: 28,
    paddingBottom: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  heading: { color: C.ink, fontSize: 16, fontWeight: "600", marginBottom: 22 },
  mapLoading: { height: 220 },
  legend: { flexDirection: "row", flexWrap: "wrap", columnGap: 15, rowGap: 8, marginTop: 13 },
  legendText: { color: C.muted, fontSize: 12 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendLine: { width: 18, height: 0, borderTopWidth: 2 },
  legendDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: MAP_COLORS.lastKnown },
  positionNote: { color: C.muted, fontSize: 12, lineHeight: 19, marginTop: 12 },
  fact: { flexDirection: "row", gap: 16, minHeight: 86 },
  factRail: { width: 16, alignItems: "center" },
  factDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.line, marginTop: 7 },
  factDotActive: { backgroundColor: C.green },
  factLine: { width: 1, flex: 1, backgroundColor: C.line, marginTop: 5 },
  factBody: { flex: 1, paddingBottom: 24 },
  factTitle: { color: C.ink, fontSize: 14, fontWeight: "500", lineHeight: 22 },
  factTitleActive: { color: C.green, fontWeight: "600" },
  factMeta: { color: C.muted, fontSize: 12, marginTop: 6, lineHeight: 19 },
  factDescription: { color: C.muted, fontSize: 13, lineHeight: 20, marginTop: 7 },
  empty: { color: C.muted, fontSize: 14 },
  expand: {
    minHeight: 48,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  expandText: {
    color: C.green,
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 1,
    textAlign: "center",
  },
  pressed: { opacity: UI.pressedOpacity },
});

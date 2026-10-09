import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { ChevronRight, EyeOff, LockKeyhole, MailOpen } from "lucide-react-native";
import { getApi, getSessionVersion, subscribeSession } from "../../src/api";
import type { LetterView } from "../../src/api/letterApi";
import { ReadLetterRitual } from "../../src/letters/LetterRitual";
import { openReadableLetter, readableLetter } from "../../src/letters/ritual";
import { AuthExpiredError } from "../../src/api/authenticatedFetch";
import { formatFactTime } from "../../src/map/presentation";
import { DETAIL_POLL_MS } from "../../src/refresh/poller";
import { usePolling } from "../../src/refresh/usePolling";
import { ActionButton, Notice, ScreenHeader } from "../../src/ui/controls";
import { bodyTextFor, isTerminal, problemMessage, statusCopy, TRANSPORT_LABELS } from "../../src/ui/presentation";
import { type Colors, UI } from "../../src/ui/theme";
import { useAppTheme, useThemedStyles } from "../../src/ui/ThemeProvider";
import { LetterPaper, PaperReader, type PaperFrame } from "../../src/letters/LetterPaper";

export default function LetterDetailScreen() {
  const { colors: C } = useAppTheme();
  const styles = useThemedStyles(createStyles);

  const { trackingNo } = useLocalSearchParams<{ trackingNo: string }>();
  const [busy, setBusy] = useState(false);
  const [reader, setReader] = useState<{ letter: LetterView; session: number } | null>(null);
  const [revealed, setRevealed] = useState<{ letter: LetterView; session: number } | null>(null);
  const [paperReader, setPaperReader] = useState<{ letter: LetterView; session: number } | null>(null);
  const [closePaper, setClosePaper] = useState(false);
  const paper = useRef<View>(null);
  const paperFrame = useRef<PaperFrame | undefined>(undefined);
  function measurePaper() {
    paper.current?.measureInWindow((x, y, width, height) => {
      if (width > 0 && height > 0) paperFrame.current = { x, y, width, height };
    });
  }
  const session = useSyncExternalStore(subscribeSession, getSessionVersion, getSessionVersion);
  const load = useCallback(async () => {
    const [letter, timeline] = await Promise.all([
      getApi().getLetter(trackingNo),
      getApi().getTimeline(trackingNo),
    ]);
    return { letter, timeline };
  }, [trackingNo]);
  const { data, error, refresh } = usePolling(load, DETAIL_POLL_MS);
  const letter = revealed?.session === session && revealed.letter.trackingNo === trackingNo && data?.letter.readState !== "OPENED"
    ? revealed.letter : data?.letter;
  const latest = data?.timeline.at(-1);
  const recipientView = letter?.readState !== undefined;
  const bodyText = letter ? bodyTextFor(letter) : null;
  const paperExpanded = [reader, paperReader].some((active) => active?.session === session && active.letter.trackingNo === trackingNo);

  async function act(operation: () => Promise<void>, after?: () => void) {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
      if (after) after();
      else await refresh();
    } catch (failure) {
      if (failure instanceof AuthExpiredError) router.replace("/");
      else Alert.alert("操作未完成", problemMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function hide() {
    Alert.alert("隐藏这封信？", "只会从你的信件列表中隐藏。", [
      { text: "取消", style: "cancel" },
      {
        text: "隐藏",
        style: "destructive",
        onPress: () =>
          void act(
            () => getApi().hideLetter(trackingNo),
            () => router.replace("/letters")
          ),
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.page} onScroll={measurePaper} scrollEventThrottle={64}>
        <ScreenHeader
          title="信件详情"
          backLabel="返回查件"
          onBack={() => (router.canGoBack() ? router.back() : router.replace("/letters"))}
          trailing={
            letter && isTerminal(letter.status) ? (
              <Pressable
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel="隐藏这封信"
                disabled={busy}
                onPress={hide}
              >
                <EyeOff size={20} color={C.muted} />
              </Pressable>
            ) : null
          }
        />
        {error ? <Notice>信件暂时无法更新，请稍后重试</Notice> : null}
        {!data ? <ActivityIndicator color={C.green} style={styles.loading} /> : null}
        {letter ? (
          <>
            <Pressable
              style={({ pressed }) => [styles.logisticsEntry, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="查看物流详情"
              onPress={() => router.push(`/letters/${trackingNo}/logistics`)}
            >
              <View style={styles.entryTop}>
                <Text style={styles.entryStatus}>{statusCopy(letter.status)}</Text>
                <ChevronRight size={19} color={C.green} />
              </View>
              <Text style={styles.entryLatest} numberOfLines={2}>
                {latest?.title ?? "暂无运输动态"}
              </Text>
              <Text style={styles.entryMeta}>
                {latest
                  ? `${latest.location.city} · ${formatFactTime(latest.happenedAt)}`
                  : `${letter.origin.city} → ${letter.target.city}`}
              </Text>
              <Text style={styles.entryTracking}>运单号 {letter.trackingNo}</Text>
            </Pressable>

            <View style={styles.section}>
              <Text accessibilityRole="header" style={styles.heading}>
                信件内容
              </Text>
              {letter.decryptionError ? (
                <ActionButton
                  title="恢复密钥或核对安全码"
                  onPress={() => {
                    Alert.alert(
                      "加密信件未解锁",
                      problemMessage(new Error(letter.decryptionError))
                    );
                    router.push({
                      pathname: "/encryption",
                      params: { uid: recipientView ? letter.sender.uid : letter.recipient.uid },
                    });
                  }}
                />
              ) : null}
              {bodyText !== null && !letter.decryptionError ? (
                <View ref={paper} collapsable={false} onLayout={measurePaper}>
                  <LetterPaper letter={letter} concealed={paperExpanded} onPress={() => {
                    measurePaper();
                    setClosePaper(false);
                    setPaperReader({ letter, session });
                  }} />
                </View>
              ) : (
                <View style={styles.locked}>
                  <LockKeyhole size={19} color={C.muted} />
                  <Text style={styles.lockedText}>
                    {letter.status === "DELIVERED"
                      ? "信已送达，拆阅后查看"
                      : isTerminal(letter.status)
                        ? "这封信未能送达"
                        : "送达后可以查看"}
                  </Text>
                </View>
              )}
              {recipientView && letter.status === "DELIVERED" && letter.readState !== "OPENED" ? (
                <View style={styles.action}>
                  <ActionButton
                    title="拆开"
                    icon={MailOpen}
                    disabled={busy}
                    onPress={() => setReader({ letter, session })}
                  />
                </View>
              ) : null}
            </View>

            <View style={styles.section}>
              <Text accessibilityRole="header" style={styles.heading}>
                寄收信息
              </Text>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>寄送方式</Text>
                <Text style={styles.infoValue}>{TRANSPORT_LABELS[letter.initialTransport]}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>寄件人</Text>
                <Text style={styles.infoValue}>{letter.sender.nickname}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>收件人</Text>
                <Text style={styles.infoValue}>{letter.recipient.nickname}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>寄件地区</Text>
                <Text style={styles.infoValue}>
                  {letter.origin.province} {letter.origin.city} {letter.origin.district}
                </Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>收件地区</Text>
                <Text style={styles.infoValue}>
                  {letter.target.province} {letter.target.city} {letter.target.district}
                </Text>
              </View>
            </View>
          </>
        ) : null}
      </ScrollView>
      {reader && reader.session === session && reader.letter.trackingNo === trackingNo ? (
        <ReadLetterRitual
          key={`${session}:${trackingNo}`}
          letter={reader.letter}
          onClose={() => { setReader(null); void refresh(); }}
          getPaperTarget={() => paperFrame.current}
          onRevealed={(result) => {
            if (getSessionVersion() === session && result.trackingNo === trackingNo)
              setRevealed({ letter: result, session });
            measurePaper();
          }}
          onComplete={(result) => {
            if (getSessionVersion() !== session || result.trackingNo !== trackingNo || !readableLetter(result)) return;
            setRevealed({ letter: result, session });
            setReader(null);
            void refresh();
          }}
          onOpen={async () => {
            const result = await openReadableLetter(trackingNo, getApi());
            // Prepare the authorized destination while the envelope is still opaque.
            if (getSessionVersion() === session && result.trackingNo === trackingNo)
              setRevealed({ letter: result, session });
            return result;
          }}
        />
      ) : null}
      {paperReader && paperReader.session === session && paperReader.letter.trackingNo === trackingNo ? (
        <Modal visible transparent animationType="none" presentationStyle="overFullScreen" onRequestClose={() => setClosePaper(true)}>
          <SafeAreaProvider>
            <PaperReader key={`${session}:${trackingNo}`} letter={paperReader.letter} closeRequested={closePaper}
              getTarget={() => paperFrame.current} onClose={() => setPaperReader(null)} />
          </SafeAreaProvider>
        </Modal>
      ) : null}
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
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: UI.pressedOpacity },
  loading: { marginTop: 36 },
  logisticsEntry: {
    backgroundColor: C.greenSoft,
    borderRadius: UI.radius,
    padding: 20,
    marginTop: 16,
  },
  entryTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  entryStatus: { color: C.green, fontSize: 19, fontWeight: "600", flex: 1 },
  entryLatest: { color: C.ink, fontSize: 14, lineHeight: 22, marginTop: 12 },
  entryMeta: { color: C.muted, fontSize: 12, lineHeight: 18, marginTop: 6 },
  entryTracking: {
    color: C.muted,
    fontSize: 11,
    lineHeight: 18,
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: C.softBorder,
  },
  section: {
    paddingTop: 32,
    paddingBottom: 24,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  heading: { color: C.muted, fontSize: 13, fontWeight: "600", marginBottom: 22 },
  locked: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 20 },
  lockedText: { color: C.muted, flex: 1, fontSize: 15, lineHeight: 24 },
  action: { marginTop: 14 },
  infoRow: { flexDirection: "row", justifyContent: "space-between", gap: 20, marginBottom: 18 },
  infoLabel: { color: C.muted, fontSize: 14, lineHeight: 22 },
  infoValue: { color: C.ink, fontSize: 14, lineHeight: 22, textAlign: "right", flex: 1 },
});

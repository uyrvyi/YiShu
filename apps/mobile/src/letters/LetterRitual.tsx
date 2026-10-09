import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  AccessibilityInfo, ActivityIndicator, Alert, Animated, AppState, Easing,
  Modal, Pressable, StyleSheet, Text, View, useWindowDimensions,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, ClipPath, Defs, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { X } from "lucide-react-native";
import { getSessionVersion, subscribeSession } from "../api";
import type { LetterView } from "../api/letterApi";
import { problemMessage } from "../ui/presentation";
import { C, type Colors } from "../ui/theme";
import { useAppTheme, useThemedStyles } from "../ui/ThemeProvider";
import { readableLetter, RITUAL_DURATION } from "./ritual";
import { PaperReader, type PaperFrame } from "./LetterPaper";
import { ENVELOPE_GEOMETRY as EG, envelopeLayout } from "./envelopeGeometry";

const ENVELOPE = "#E8D4AD";
const WAX = "#923E48";

function usePresentation() {
  // Start conservatively until the accessibility preference has been read.
  const [reduceMotion, setReduceMotion] = useState(true);
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (live) setReduceMotion(value); });
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    const state = AppState.addEventListener("change", (value) => setActive(value === "active"));
    return () => { live = false; motion.remove(); state.remove(); };
  }, []);
  return { reduceMotion, active };
}

function useStageAnimation(value: Animated.Value, duration: number, enabled: boolean, complete: () => void, opening = false) {
  const latest = useRef(complete);
  latest.current = complete;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const animation = Animated.timing(value, {
      // Opening also drives the paper's clipping height, so all layers share the JS timeline.
      toValue: 1, duration, easing: opening ? Easing.bezier(0.4, 0, 0.2, 1) : Easing.inOut(Easing.cubic), useNativeDriver: !opening,
    });
    animation.start(({ finished }) => {
      if (live && finished && AppState.currentState === "active") latest.current();
    });
    return () => { live = false; animation.stop(); };
  }, [value, duration, enabled, opening]);
}

function PaperArt({ width, height }: { width: number; height: number }) {
  const { colors: C } = useAppTheme();

  return <Svg width={width} height={height} viewBox="0 0 300 210">
    <Rect x="1" y="1" width="298" height="208" rx="5" fill={C.paper} stroke={C.paperArtBorder} />
    <SvgText x="25" y="43" fill={C.paperAccent} fontSize="18">驿书</SvgText>
    {[70, 92, 114, 136, 158].map((y) => <Line key={y} x1="25" x2={y === 158 ? "190" : "272"} y1={y} y2={y} stroke={C.paperArtRule} />)}
  </Svg>;
}

function EnvelopeArt({ width, front = false, flap = false }: { width: number; front?: boolean; flap?: boolean }) {
  const clipId = `envelope-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const layout = envelopeLayout(width);
  const outline = { x: EG.inset, y: EG.inset, width: EG.width - 2 * EG.inset, height: EG.height - 2 * EG.inset, rx: EG.radius };
  return <Svg testID={flap ? "envelope-flap-art" : front ? "envelope-front-art" : "envelope-back-art"}
    width={width} height={flap ? layout.flapHeight : layout.height}
    viewBox={flap ? `0 ${EG.inset} ${EG.width} ${EG.flapHeight}` : `0 0 ${EG.width} ${EG.height}`}>
    <Defs><ClipPath id={clipId}><Rect {...outline} /></ClipPath></Defs>
    {!front && !flap ? <Rect {...outline} fill="#D7BD91" /> : null}
    <G clipPath={`url(#${clipId})`}>
    {front ? <>
      <Path d={EG.pocket} fill={ENVELOPE} />
      <Path d={EG.bottom} fill="#EEDDBD" />
      <Path d={EG.bottomSeam} fill="none" stroke="#C5B18C" strokeWidth={1} strokeLinejoin="round" />
      <Rect x="292" y="157" width="44" height="52" rx="3" fill="#F8F3E7" stroke={C.green} strokeDasharray="3 3" />
      <SvgText x="314" y="187" textAnchor="middle" fontSize="20" fill={C.green}>驿</SvgText>
      <Line x1="29" x2="117" y1="188" y2="188" stroke="#B6A483" />
      <Line x1="29" x2="89" y1="203" y2="203" stroke="#B6A483" />
    </> : null}
    {flap ? <>
      <Path d={EG.flap} fill="#F0DFBD" />
      <Path d={EG.flapSeam} fill="none" stroke="#BDA57E" strokeWidth={1} strokeLinejoin="round" />
    </> : null}
    </G>
    {front ? <Rect testID="envelope-outline" {...outline} fill="none" stroke="#BAA17B" strokeWidth={1} /> : null}
  </Svg>;
}

function Wax() {
  return <Svg width={48} height={48} viewBox="0 0 48 48">
    <Circle cx="24" cy="24" r="22" fill={WAX} />
    <Circle cx="24" cy="24" r="17" fill="none" stroke="#B96870" />
    <SvgText x="24" y="30" textAnchor="middle" fontSize="19" fill="#F9DED5">书</SvgText>
  </Svg>;
}

function EnvelopeScene({ insert, seal, width }: {
  insert?: Animated.Value; seal?: Animated.Value; width: number;
}) {
  const styles = useThemedStyles(createStyles);

  const { height, flapHeight, hingeY, sealLeft, sealTop } = envelopeLayout(width);
  return <View style={[styles.scene, { width, height: height + 100 }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <View style={[styles.envelope, { width, height }]}><EnvelopeArt width={width} /></View>
    <Animated.View style={[styles.illustratedPaper, { height: height * 0.84 }, {
      transform: [
        { translateY: insert ? insert.interpolate({ inputRange: [0, 0.35, 1], outputRange: [-100, -70, height * 0.28] }) : height * 0.28 },
        { scaleY: insert ? insert.interpolate({ inputRange: [0, 0.35, 1], outputRange: [1, 0.55, 0.55] }) : 1 },
      ],
    }]}><PaperArt width={width * 0.84} height={height * 0.84} /></Animated.View>
    <View style={[styles.envelope, { width, height }]}><EnvelopeArt width={width} front /></View>
    <Animated.View testID="sending-envelope-flap" style={[styles.flap, { top: 80 + hingeY, width, height: flapHeight,
      transform: [{ perspective: 800 }, { rotateX: seal ? seal.interpolate({ inputRange: [0, 1], outputRange: ["-178deg", "0deg"] }) : "0deg" }],
    }]}><EnvelopeArt width={width} flap /></Animated.View>
    <Animated.View testID="sending-envelope-seal" style={[styles.wax, { left: sealLeft, top: 80 + sealTop, opacity: seal ?? 1,
      transform: [{ scale: seal ? seal.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.01, 0.01, 1] }) : 1 }],
    }]}><Wax /></Animated.View>
  </View>;
}

function OpeningEnvelope({ width, reveal }: { width: number; reveal: Animated.Value }) {
  const styles = useThemedStyles(createStyles);

  const { height, flapHeight, hingeY } = envelopeLayout(width);
  return <View style={{ width, height }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <EnvelopeArt width={width} front />
    <Animated.View testID="opening-envelope-flap" style={[styles.flap, { top: hingeY, width, height: flapHeight,
      transform: [{ perspective: 800 }, { rotateX: reveal.interpolate({ inputRange: [0, 0.26, 1], outputRange: ["0deg", "-178deg", "-178deg"] }) }],
    }]}>
      <EnvelopeArt width={width} flap />
    </Animated.View>
  </View>;
}

export function SendLetterRitual({ ready, onComplete }: { ready: boolean; onComplete: () => void }) {
  const { colors: C } = useAppTheme();
  const styles = useThemedStyles(createStyles);

  const { width } = useWindowDimensions();
  const { reduceMotion, active } = usePresentation();
  const [inserted, setInserted] = useState(false);
  const [sealed, setSealed] = useState(false);
  const insert = useRef(new Animated.Value(0)).current;
  const seal = useRef(new Animated.Value(0)).current;
  const hold = useRef(new Animated.Value(0)).current;
  useStageAnimation(insert, reduceMotion ? 100 : RITUAL_DURATION.insert, active && !inserted, () => setInserted(true));
  useStageAnimation(seal, reduceMotion ? 100 : RITUAL_DURATION.seal, active && inserted && ready && !sealed, () => setSealed(true));
  useStageAnimation(hold, RITUAL_DURATION.sealedHold, active && sealed, onComplete);
  // The confirmation and ritual share one native modal to avoid overlapping iOS presentations.
  return <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <View style={styles.stage}>
        <EnvelopeScene width={Math.min(420, width - 48)} insert={reduceMotion ? undefined : insert} seal={seal} />
        <Text style={styles.caption} accessibilityRole="header" accessibilityLiveRegion="polite">{ready && inserted ? "封好这封信" : "正在寄出"}</Text>
        {!ready && inserted ? <ActivityIndicator color={C.green} /> : null}
      </View>
    </SafeAreaView>;
}

export function ReadLetterRitual({ letter, onOpen, onClose, onComplete, onRevealed, getPaperTarget }: {
  letter: LetterView; onOpen: () => Promise<LetterView>; onClose: () => void; onComplete: (letter: LetterView) => void;
  onRevealed: (letter: LetterView) => void; getPaperTarget: () => PaperFrame | undefined;
}) {
  const { colors: C } = useAppTheme();
  const styles = useThemedStyles(createStyles);

  const session = useSyncExternalStore(subscribeSession, getSessionVersion, getSessionVersion);
  const initialSession = useRef(session).current;
  const { reduceMotion, active } = usePresentation();
  const { width } = useWindowDimensions();
  const size = Math.min(420, width - 48);
  const layout = envelopeLayout(size);
  const [opened, setOpened] = useState<LetterView | null>(readableLetter(letter) ? letter : null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [closeRequested, setCloseRequested] = useState(false);
  const [envelopeFrame, setEnvelopeFrame] = useState<PaperFrame>();
  const [paperMeasured, setPaperMeasured] = useState(false);
  const envelope = useRef<View>(null);
  const live = useRef(true);
  const locked = useRef(false);
  const completed = useRef(readableLetter(letter));
  const returned = useRef(false);
  const reveal = useRef(new Animated.Value(0)).current;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const callbacks = useRef({ onOpen, onClose, onComplete, onRevealed });
  callbacks.current = { onOpen, onClose, onComplete, onRevealed };
  useStageAnimation(reveal, reduceMotion ? 100 : RITUAL_DURATION.reveal, active && session === initialSession && !!opened && !!envelopeFrame && paperMeasured && !reading, () => {
    if (!opened || !live.current || returned.current || initialSession !== getSessionVersion()) return;
    setReading(true);
    callbacks.current.onRevealed(opened);
  }, true);

  async function finish() {
    if (locked.current || completed.current || !live.current || !active || session !== initialSession) return;
    locked.current = true;
    setBusy(true);
    try {
      const result = await callbacks.current.onOpen();
      if (!readableLetter(result)) throw new Error(result.decryptionError ?? "正文暂时无法读取，请重试。");
      if (live.current && initialSession === getSessionVersion()) {
        completed.current = true;
        setOpened(result);
      }
    } catch (failure) {
      if (live.current && initialSession === getSessionVersion()) {
        Alert.alert("拆信未完成", problemMessage(failure));
      }
    } finally {
      locked.current = false;
      if (live.current) setBusy(false);
    }
  }
  function close() {
    if (reading) { setCloseRequested(true); return; }
    // Suppress late requests and animations even before React unmounts the modal.
    live.current = false;
    callbacks.current.onClose();
  }

  if (session !== initialSession) return null;
  const envelopeOpacity = reveal.interpolate({ inputRange: [0, 0.6, 1], outputRange: [1, 1, 0] });
  return <Modal visible transparent animationType="none" presentationStyle="overFullScreen" onRequestClose={close}>
    <SafeAreaProvider>
    <View style={{ flex: 1 }}>
    <Animated.View style={[StyleSheet.absoluteFill, { opacity: envelopeOpacity }]}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal accessibilityElementsHidden={reading} importantForAccessibility={reading ? "no-hide-descendants" : "auto"}>
      <View style={styles.header}>
        <Text style={styles.title}>一封来信</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭信封" onPress={close} style={styles.close}><X size={23} color={C.ink} /></Pressable>
      </View>
      <View style={styles.stage}>
        <View style={{ width: size, height: layout.height + 100 }}>
          <View ref={envelope} collapsable={false} testID="opening-envelope-frame"
            style={[styles.envelope, { width: size, height: layout.height }]}
            onLayout={() => envelope.current?.measureInWindow((x, y, measuredWidth, measuredHeight) => {
              if (live.current && measuredWidth > 0 && measuredHeight > 0)
                setEnvelopeFrame({ x, y, width: measuredWidth, height: measuredHeight });
            })}>
            <EnvelopeArt width={size} />
          </View>
        </View>
        <Text style={[styles.tearHint, { opacity: !opened && !busy ? 1 : 0 }]} accessibilityElementsHidden={!!opened || busy}>轻点骑缝章，展开来信</Text>
      </View>
    </SafeAreaView>
    </Animated.View>
    {opened ? <PaperReader letter={opened} entrance={reveal} fromEnvelope entranceFrame={envelopeFrame}
      onMeasured={() => setPaperMeasured(true)} ready={reading}
      closeRequested={closeRequested} getTarget={getPaperTarget} onClose={() => {
        if (!live.current || returned.current || initialSession !== getSessionVersion()) return;
        returned.current = true;
        callbacks.current.onComplete(opened);
      }} /> : null}
    {envelopeFrame ? <Animated.View testID="opening-envelope-front" pointerEvents={opened ? "none" : "box-none"}
      accessibilityElementsHidden={!!opened} importantForAccessibility={opened ? "no-hide-descendants" : "auto"}
      style={{ position: "absolute", zIndex: 1, left: envelopeFrame.x, top: envelopeFrame.y, width: size, height: layout.height,
        opacity: envelopeOpacity }}>
      <OpeningEnvelope width={size} reveal={reveal} />
      <Pressable accessibilityRole="button" accessibilityLabel="点击骑缝章拆信"
        accessibilityState={{ busy, disabled: busy || !!opened || !active }} disabled={busy || !!opened || !active}
        onPress={() => void finish()} style={[styles.sealButton, { left: layout.sealLeft, top: layout.sealTop }]}>
        <Animated.View pointerEvents="none" style={{
          opacity: reveal.interpolate({ inputRange: [0, 0.12, 0.26, 1], outputRange: [1, 1, 0, 0] }),
          transform: [{ scale: reveal.interpolate({ inputRange: [0, 0.26, 1], outputRange: [1, 1.15, 1.15] }) }],
        }}>{busy ? <ActivityIndicator color={WAX} accessibilityLabel="正在拆阅" /> : <Wax />}</Animated.View>
      </Pressable>
    </Animated.View> : null}
    </View>
    </SafeAreaProvider>
  </Modal>;
}

const createStyles = (C: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.canvas },
  stage: { flex: 1, alignItems: "center", justifyContent: "center", gap: 24, paddingBottom: 60 },
  scene: { position: "relative" },
  envelope: { position: "absolute", left: 0, right: 0, top: 80 },
  illustratedPaper: { position: "absolute", top: 80, left: "8%", right: "8%" },
  flap: { position: "absolute", left: 0, transformOrigin: "50% 0%", backfaceVisibility: "visible" },
  wax: { position: "absolute" },
  caption: { color: C.ink, fontSize: 18, fontWeight: "500" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingVertical: 12, gap: 12 },
  title: { flex: 1, color: C.ink, fontSize: 18, fontWeight: "600" },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  sealButton: { position: "absolute", width: EG.sealSize, height: EG.sealSize, alignItems: "center", justifyContent: "center" },
  tearHint: { color: C.muted, fontSize: 14 },
});

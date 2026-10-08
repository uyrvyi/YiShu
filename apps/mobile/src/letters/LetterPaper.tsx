import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, Line, Pattern, Rect } from "react-native-svg";
import type { LetterView } from "../api/letterApi";
import { bodyTextFor } from "../ui/presentation";
import { formatFactTime } from "../map/presentation";
import { PrivateImages } from "../media/PrivateImage";
import { C } from "../ui/theme";

export type PaperFrame = { x: number; y: number; width: number; height: number };

function LinedBody({ children }: { children: string }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  return <View>
    {size.width > 0 && size.height > 0 ? <Svg width={size.width} height={size.height} style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden>
      <Defs><Pattern id="letter-ruling" width="1" height="32" patternUnits="userSpaceOnUse">
        <Line x1="0" x2={size.width} y1="31" y2="31" stroke="#DDD6C5" strokeWidth="0.5" />
      </Pattern></Defs>
      <Rect width={size.width} height={size.height} fill="url(#letter-ruling)" />
    </Svg> : null}
    <Text style={styles.body} onLayout={({ nativeEvent: { layout } }) => {
      if (layout.width !== size.width || layout.height !== size.height) setSize({ width: layout.width, height: layout.height });
    }}>{children}</Text>
  </View>;
}

export function LetterPaper({ letter, onPress }: { letter: LetterView; onPress: () => void }) {
  const body = bodyTextFor(letter);
  if (body === null || letter.decryptionError) return null;
  return <View style={styles.paper} testID="letter-paper">
    <Pressable accessibilityRole="button" accessibilityLabel="展开信纸" onPress={onPress} style={styles.textBlock}>
      <Text style={styles.brand}>驿书</Text>
      <LinedBody>{body}</LinedBody>
    </Pressable>
    <View style={styles.images}><PrivateImages images={letter.images ?? []} /></View>
    <Pressable accessibilityRole="button" accessibilityLabel="展开信纸" onPress={onPress} style={styles.footer}>
      {letter.writtenAt ? <Text style={styles.date}>写于 {formatFactTime(letter.writtenAt)}</Text> : null}
      <View style={styles.rule} />
    </Pressable>
  </View>;
}

// Reuse the envelope modal on first opening; subsequent openings use the same paper surface.
export function PaperReader({ letter, entrance, fromEnvelope = false, entranceFrame, onMeasured, ready = true, closeRequested = false, getTarget, onClose }: {
  letter: LetterView; entrance?: Animated.Value; fromEnvelope?: boolean; ready?: boolean;
  entranceFrame?: PaperFrame; onMeasured?: () => void;
  closeRequested?: boolean; getTarget: () => PaperFrame | undefined; onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const enter = useRef(new Animated.Value(0)).current;
  const exit = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);
  const live = useRef(true);
  const movement = useRef({ x: 0, y: 0, moved: false });
  const [target, setTarget] = useState<PaperFrame | undefined>(getTarget());
  const [closingNow, setClosingNow] = useState(false);
  const [naturalHeight, setNaturalHeight] = useState(0);
  const scrollY = useRef(0);
  const [reduce, setReduce] = useState(true);
  const callback = useRef(onClose);
  callback.current = onClose;
  const measuredCallback = useRef(onMeasured);
  measuredCallback.current = onMeasured;
  useEffect(() => {
    live.current = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (live.current) setReduce(value); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => { live.current = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    if (entrance) return;
    const animation = Animated.timing(enter, { toValue: 1, duration: reduce ? 100 : 380, easing: Easing.bezier(0.2, 0, 0.2, 1), useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [entrance, enter, reduce]);
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  useEffect(() => () => animation.current?.stop(), []);
  const safeTop = insets.top + 16;
  const availableHeight = Math.max(100, height - safeTop - insets.bottom - 16);
  const centerSpace = naturalHeight ? Math.max(0, (availableHeight - naturalHeight) / 2) : 0;
  const top = safeTop + centerSpace;
  const paperWidth = Math.min(640, width - 32);
  const paperLeft = (width - paperWidth) / 2;
  const paperHeight = naturalHeight || availableHeight;
  const frame = target ?? { x: paperLeft, y: top + paperHeight * 0.25, width: paperWidth, height: paperHeight * 0.5 };
  const visibleHeight = Math.max(32, Math.min(frame.height, height - Math.max(insets.top, frame.y) - insets.bottom));
  const dx = frame.x + frame.width / 2 - (paperLeft + paperWidth / 2);
  const dy = Math.max(insets.top, frame.y) + visibleHeight / 2 - (top - scrollY.current + paperHeight / 2);
  function close() {
    if (!ready || closing.current || !live.current) return;
    closing.current = true;
    setTarget(getTarget() ?? frame);
    setClosingNow(true);
  }
  useEffect(() => { if (closeRequested) close(); }, [closeRequested, ready]);
  // Start after React has committed the measured destination, not with a stale frame.
  useEffect(() => {
    if (!closingNow) return;
    animation.current = Animated.timing(exit, { toValue: 1, duration: reduce ? 100 : 360, easing: Easing.bezier(0.4, 0, 0.2, 1), useNativeDriver: true });
    animation.current.start(({ finished }) => { if (finished && live.current) callback.current(); });
    return () => animation.current?.stop();
  }, [closingNow, target, exit, reduce]);
  const appear = entrance ?? enter;
  const inputRange = [0, 0.01, 1];
  const opacity = appear.interpolate({ inputRange, outputRange: [0, 0, 1], extrapolate: "clamp" });
  const envelopeRange = [0, 0.26, 0.6, 1];
  const source = entranceFrame ?? frame;
  const sourceScale = source.width * 0.84 / paperWidth;
  const sourceX = source.x + source.width / 2 - (paperLeft + paperWidth / 2);
  const sourceY = source.y + source.height * 0.12 - top;
  const extractedY = source.y - source.height * 0.8 - top;
  const clippedHeight = Math.min(paperHeight, source.height * 0.84 / sourceScale);
  const body = bodyTextFor(letter);
  if (body === null || letter.decryptionError) return null;
  return <Animated.View style={[StyleSheet.absoluteFill, {
    // Keep the envelope in front during extraction, then lift this same paper before enlargement.
    zIndex: fromEnvelope && entrance ? appear.interpolate({ inputRange: [0, 0.59, 0.6, 1], outputRange: [0, 0, 2, 2], extrapolate: "clamp" }) : 2,
  }]} pointerEvents={ready && !closingNow ? "auto" : "none"} accessibilityElementsHidden={!ready} importantForAccessibility={ready ? "auto" : "no-hide-descendants"} accessibilityViewIsModal testID="paper-reader">
    <Animated.View style={[StyleSheet.absoluteFill, { opacity: exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}>
      <Animated.View style={[StyleSheet.absoluteFill, {
        opacity: fromEnvelope ? appear.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, 1] }) : opacity,
        backgroundColor: "rgba(26,32,28,0.22)",
      }]} />
      <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="收起信纸" onPress={close} />
    </Animated.View>
    <ScrollView style={StyleSheet.absoluteFill} scrollEnabled={ready && !closingNow} removeClippedSubviews={false}
      contentContainerStyle={{ flexGrow: 1, paddingTop: safeTop, paddingBottom: insets.bottom + 16, paddingHorizontal: paperLeft }}
      onScroll={(event) => { scrollY.current = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={32}
      onScrollBeginDrag={() => { movement.current.moved = true; }}
      onTouchStart={(event) => { const { pageX, pageY } = event.nativeEvent; movement.current = { x: pageX, y: pageY, moved: false }; }}
      onTouchMove={(event) => { const { pageX, pageY } = event.nativeEvent; if (Math.hypot(pageX - movement.current.x, pageY - movement.current.y) > 8) movement.current.moved = true; }}>
    <Pressable testID="paper-reader-top-space" style={{ height: centerSpace }} accessible={centerSpace > 0} accessibilityRole="button" accessibilityLabel="收起信纸" onPress={() => { if (!movement.current.moved) close(); }} />
    <Animated.View testID="paper-reader-layout" style={{ width: paperWidth, height: naturalHeight || undefined,
      opacity: exit.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 1, 0] }),
      transform: [
        { translateX: exit.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
        { translateY: exit.interpolate({ inputRange: [0, 1], outputRange: [0, dy] }) },
        { scaleX: exit.interpolate({ inputRange: [0, 1], outputRange: [1, frame.width / paperWidth] }) },
        { scaleY: exit.interpolate({ inputRange: [0, 1], outputRange: [1, visibleHeight / paperHeight] }) },
      ] }}>
      <Animated.View testID="continuous-reading-paper" style={{
        opacity: fromEnvelope ? (entranceFrame && naturalHeight ? 1 : 0) : opacity,
        transformOrigin: fromEnvelope ? "50% 0%" : "50% 50%",
        transform: fromEnvelope ? [
          { translateX: appear.interpolate({ inputRange: envelopeRange, outputRange: [sourceX, sourceX, sourceX, 0], extrapolate: "clamp" }) },
          { translateY: appear.interpolate({ inputRange: envelopeRange, outputRange: [sourceY, sourceY, extractedY, 0], extrapolate: "clamp" }) },
          { scale: appear.interpolate({ inputRange: envelopeRange, outputRange: [sourceScale, sourceScale, sourceScale, 1], extrapolate: "clamp" }) },
        ] : [
          { translateX: appear.interpolate({ inputRange, outputRange: [dx, dx, 0], extrapolate: "clamp" }) },
          { translateY: appear.interpolate({ inputRange, outputRange: [dy, dy, 0], extrapolate: "clamp" }) },
          { scaleX: appear.interpolate({ inputRange, outputRange: [frame.width / paperWidth, frame.width / paperWidth, 1], extrapolate: "clamp" }) },
          { scaleY: appear.interpolate({ inputRange, outputRange: [visibleHeight / paperHeight, visibleHeight / paperHeight, 1], extrapolate: "clamp" }) },
        ],
      }}>
        <Animated.View style={{ overflow: "hidden", borderRadius: 8,
          height: fromEnvelope && naturalHeight ? appear.interpolate({ inputRange: envelopeRange,
            outputRange: [clippedHeight, clippedHeight, clippedHeight, naturalHeight], extrapolate: "clamp" }) : undefined,
        }}>
        <View testID="reading-paper-content" style={styles.readingPaper} onLayout={(event) => {
          const measured = event.nativeEvent.layout.height;
          if (measured > 0) {
            if (measured !== naturalHeight) setNaturalHeight(measured);
            measuredCallback.current?.();
          }
        }}>
          <Pressable accessibilityRole="button" accessibilityLabel="收起信纸" onPress={() => { if (!movement.current.moved) close(); }}>
            <Text style={styles.brand}>驿书</Text>
            <LinedBody>{body}</LinedBody>
          </Pressable>
          <PrivateImages images={letter.images ?? []} />
          <Pressable accessibilityRole="button" accessibilityLabel="收起信纸" onPress={() => { if (!movement.current.moved) close(); }} style={styles.readingFooter}>
            {letter.writtenAt ? <Text style={styles.date}>写于 {formatFactTime(letter.writtenAt)}</Text> : null}
            <View style={styles.rule} />
          </Pressable>
        </View>
        </Animated.View>
      </Animated.View>
    </Animated.View>
    <Pressable testID="paper-reader-bottom-space" style={{ flexGrow: 1, minHeight: centerSpace }} accessible={centerSpace > 0} accessibilityRole="button" accessibilityLabel="收起信纸" onPress={() => { if (!movement.current.moved) close(); }} />
    </ScrollView>
  </Animated.View>;
}

const styles = StyleSheet.create({
  paper: { backgroundColor: "#FFFCF3", borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: "#DCD2BD", paddingVertical: 24 },
  textBlock: { paddingHorizontal: 24 },
  brand: { fontSize: 17, color: C.green, fontWeight: "600", marginBottom: 24 },
  body: { color: C.ink, fontSize: 17, lineHeight: 32 },
  images: { paddingHorizontal: 24 },
  footer: { paddingHorizontal: 24, paddingTop: 24 },
  date: { color: C.muted, fontSize: 12, lineHeight: 20 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: "#DDD5C5", marginTop: 20 },
  readingPaper: { padding: 28, borderRadius: 8, backgroundColor: "#FFFCF3", overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: "#DCD2BD" },
  readingFooter: { paddingTop: 28 },
});

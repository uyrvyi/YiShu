import { useEffect, useId, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, Line, LinearGradient, Pattern, Rect, Stop } from "react-native-svg";
import type { LetterView } from "../api/letterApi";
import { bodyTextFor } from "../ui/presentation";
import { formatFactTime } from "../map/presentation";
import { PrivateImages } from "../media/PrivateImage";
import { type Colors } from "../ui/theme";
import { useAppTheme, useThemedStyles } from "../ui/ThemeProvider";

export type PaperFrame = { x: number; y: number; width: number; height: number };
const PREVIEW_HEIGHT = 320;
const FADE_HEIGHT = 40;

function PaperFade() {
  const { colors: C } = useAppTheme();
  const id = `paper-fade-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return <Svg width="100%" height={FADE_HEIGHT} pointerEvents="none" accessibilityElementsHidden>
    <Defs><LinearGradient id={id} x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
      <Stop offset="0" stopColor={C.paper} stopOpacity="0" />
      <Stop offset="1" stopColor={C.paper} stopOpacity="1" />
    </LinearGradient></Defs>
    <Rect width="100%" height={FADE_HEIGHT} fill={`url(#${id})`} />
  </Svg>;
}

function LinedBody({ children }: { children: string }) {
  const { colors: C } = useAppTheme();
  const styles = useThemedStyles(createStyles);

  const [size, setSize] = useState({ width: 0, height: 0 });
  return <View>
    {size.width > 0 && size.height > 0 ? <Svg width={size.width} height={size.height} style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden>
      <Defs><Pattern id="letter-ruling" width="1" height="32" patternUnits="userSpaceOnUse">
        <Line x1="0" x2={size.width} y1="31" y2="31" stroke={C.paperRule} strokeWidth="0.5" />
      </Pattern></Defs>
      <Rect width={size.width} height={size.height} fill="url(#letter-ruling)" />
    </Svg> : null}
    <Text style={styles.body} onLayout={({ nativeEvent: { layout } }) => {
      if (layout.width !== size.width || layout.height !== size.height) setSize({ width: layout.width, height: layout.height });
    }}>{children}</Text>
  </View>;
}

export function LetterPaper({ letter, onPress, concealed = false }: { letter: LetterView; onPress: () => void; concealed?: boolean }) {
  const styles = useThemedStyles(createStyles);

  const [naturalHeight, setNaturalHeight] = useState(0);
  const body = bodyTextFor(letter);
  if (body === null || letter.decryptionError) return null;
  return <Pressable style={{ ...styles.preview, opacity: concealed ? 0 : 1 }} testID="letter-paper" pointerEvents={concealed ? "none" : "auto"}
    accessibilityElementsHidden={concealed} importantForAccessibility={concealed ? "no-hide-descendants" : "auto"}
    accessibilityRole="button" accessibilityLabel="展开信纸" onPress={onPress}>
    <View testID="letter-paper-preview-content" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={styles.readingPaper} onLayout={({ nativeEvent: { layout } }) => {
        if (layout.height !== naturalHeight) setNaturalHeight(layout.height);
      }}>
      <LinedBody>{body}</LinedBody>
      <PrivateImages images={letter.images ?? []} />
      <View style={styles.readingFooter}>
      {letter.writtenAt ? <Text style={styles.date}>写于 {formatFactTime(letter.writtenAt)}</Text> : null}
      <View style={styles.rule} />
      </View>
    </View>
    {naturalHeight > PREVIEW_HEIGHT ? <View testID="letter-paper-preview-fade" style={styles.fade} pointerEvents="none" accessibilityElementsHidden><PaperFade /></View> : null}
  </Pressable>;
}

// Reuse the envelope modal on first opening; subsequent openings use the same paper surface.
export function PaperReader({ letter, entrance, fromEnvelope = false, entranceFrame, onMeasured, ready = true, closeRequested = false, getTarget, onClose }: {
  letter: LetterView; entrance?: Animated.Value; fromEnvelope?: boolean; ready?: boolean;
  entranceFrame?: PaperFrame; onMeasured?: () => void;
  closeRequested?: boolean; getTarget: () => PaperFrame | undefined; onClose: () => void;
}) {
  const { colors: C } = useAppTheme();
  const styles = useThemedStyles(createStyles);

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
  const [entered, setEntered] = useState(false);
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
    if (entrance || naturalHeight <= 0 || entered) return;
    const animation = Animated.timing(enter, { toValue: 1, duration: reduce ? 100 : 380, easing: Easing.bezier(0.2, 0, 0.2, 1), useNativeDriver: false });
    animation.start(({ finished }) => { if (finished && live.current) setEntered(true); });
    return () => animation.stop();
  }, [entrance, enter, reduce, naturalHeight, entered]);
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
  const previewScale = frame.width / paperWidth;
  const previewHeight = frame.height / previewScale;
  const previewClipped = paperHeight > previewHeight;
  const dx = frame.x + frame.width / 2 - (paperLeft + paperWidth / 2);
  const enterY = frame.y - top;
  const exitY = frame.y - (top - scrollY.current);
  const interactive = ready && (!!entrance || entered) && !closingNow;
  function close() {
    if (!ready || (!entrance && !entered) || closing.current || !live.current) return;
    closing.current = true;
    setTarget(getTarget() ?? frame);
    setClosingNow(true);
  }
  useEffect(() => { if (closeRequested) close(); }, [closeRequested, ready, entered]);
  // Start after React has committed the measured destination, not with a stale frame.
  useEffect(() => {
    if (!closingNow) return;
    animation.current = Animated.timing(exit, { toValue: 1, duration: reduce ? 100 : 360, easing: Easing.bezier(0.4, 0, 0.2, 1), useNativeDriver: false });
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
  }]} pointerEvents={interactive ? "auto" : "none"} accessibilityElementsHidden={!interactive} importantForAccessibility={interactive ? "auto" : "no-hide-descendants"} accessibilityViewIsModal testID="paper-reader">
    <Animated.View style={[StyleSheet.absoluteFill, { opacity: exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}>
      <Animated.View style={[StyleSheet.absoluteFill, {
        opacity: fromEnvelope ? appear.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, 1] }) : opacity,
        backgroundColor: C.paperBackdrop,
      }]} />
      <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="收起信纸" onPress={close} />
    </Animated.View>
    <ScrollView style={StyleSheet.absoluteFill} scrollEnabled={interactive} removeClippedSubviews={false}
      contentContainerStyle={{ flexGrow: 1, paddingTop: safeTop, paddingBottom: insets.bottom + 16, paddingHorizontal: paperLeft }}
      onScroll={(event) => { scrollY.current = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={32}
      onScrollBeginDrag={() => { movement.current.moved = true; }}
      onTouchStart={(event) => { const { pageX, pageY } = event.nativeEvent; movement.current = { x: pageX, y: pageY, moved: false }; }}
      onTouchMove={(event) => { const { pageX, pageY } = event.nativeEvent; if (Math.hypot(pageX - movement.current.x, pageY - movement.current.y) > 8) movement.current.moved = true; }}
      onTouchEnd={(event) => {
        const { pageX, touches } = event.nativeEvent;
        if (!movement.current.moved && touches.length === 0 && (pageX < paperLeft || pageX > paperLeft + paperWidth)) close();
      }}>
    <Pressable testID="paper-reader-top-space" style={{ height: centerSpace }} accessible={centerSpace > 0} accessibilityRole="button" accessibilityLabel="收起信纸" onPress={() => { if (!movement.current.moved) close(); }} />
    <Animated.View testID="paper-reader-layout" style={{ width: paperWidth, height: naturalHeight || undefined,
      transformOrigin: "50% 0%",
      opacity: 1,
      transform: [
        { translateX: exit.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
        { translateY: exit.interpolate({ inputRange: [0, 1], outputRange: [0, exitY] }) },
        { scale: exit.interpolate({ inputRange: [0, 1], outputRange: [1, previewScale] }) },
      ] }}>
      <Animated.View testID="continuous-reading-paper" style={{
        opacity: naturalHeight && (!fromEnvelope || entranceFrame) ? 1 : 0,
        transformOrigin: "50% 0%",
        transform: fromEnvelope ? [
          { translateX: appear.interpolate({ inputRange: envelopeRange, outputRange: [sourceX, sourceX, sourceX, 0], extrapolate: "clamp" }) },
          { translateY: appear.interpolate({ inputRange: envelopeRange, outputRange: [sourceY, sourceY, extractedY, 0], extrapolate: "clamp" }) },
          { scale: appear.interpolate({ inputRange: envelopeRange, outputRange: [sourceScale, sourceScale, sourceScale, 1], extrapolate: "clamp" }) },
        ] : [
          { translateX: appear.interpolate({ inputRange, outputRange: [dx, dx, 0], extrapolate: "clamp" }) },
          { translateY: appear.interpolate({ inputRange, outputRange: [enterY, enterY, 0], extrapolate: "clamp" }) },
          { scale: appear.interpolate({ inputRange, outputRange: [previewScale, previewScale, 1], extrapolate: "clamp" }) },
        ],
      }}>
        <Animated.View testID="paper-reader-clip" style={{ overflow: "hidden", borderRadius: 8, backgroundColor: C.paper,
          height: naturalHeight ? closingNow ? exit.interpolate({ inputRange: [0, 1], outputRange: [naturalHeight, previewHeight], extrapolate: "clamp" })
            : fromEnvelope ? appear.interpolate({ inputRange: envelopeRange, outputRange: [clippedHeight, clippedHeight, clippedHeight, naturalHeight], extrapolate: "clamp" })
            : appear.interpolate({ inputRange, outputRange: [previewHeight, previewHeight, naturalHeight], extrapolate: "clamp" }) : undefined,
        }}>
        <View testID="reading-paper-content" style={{ ...styles.readingPaper, position: "absolute", top: 0, left: 0, right: 0 }} onLayout={(event) => {
          const measured = event.nativeEvent.layout.height;
          if (measured > 0) {
            if (measured !== naturalHeight) setNaturalHeight(measured);
            measuredCallback.current?.();
          }
        }}>
          <Pressable accessibilityRole="button" accessibilityLabel="收起信纸" onPress={() => { if (!movement.current.moved) close(); }}>
            <LinedBody>{body}</LinedBody>
          </Pressable>
          <PrivateImages images={letter.images ?? []} />
          <Pressable accessibilityRole="button" accessibilityLabel="收起信纸" onPress={() => { if (!movement.current.moved) close(); }} style={styles.readingFooter}>
            {letter.writtenAt ? <Text style={styles.date}>写于 {formatFactTime(letter.writtenAt)}</Text> : null}
            <View style={styles.rule} />
          </Pressable>
        </View>
        {previewClipped && (!fromEnvelope || closingNow) ? <Animated.View testID="paper-reader-fade" pointerEvents="none" accessibilityElementsHidden style={[styles.fade, {
          opacity: closingNow ? exit.interpolate({ inputRange: [0, 0.65, 1], outputRange: [0, 0, 1], extrapolate: "clamp" })
            : appear.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0, 0], extrapolate: "clamp" }),
        }]}><PaperFade /></Animated.View> : null}
        </Animated.View>
      </Animated.View>
    </Animated.View>
    <Pressable testID="paper-reader-bottom-space" style={{ flexGrow: 1, minHeight: centerSpace }} accessible={centerSpace > 0} accessibilityRole="button" accessibilityLabel="收起信纸" onPress={() => { if (!movement.current.moved) close(); }} />
    </ScrollView>
  </Animated.View>;
}

const createStyles = (C: Colors) => StyleSheet.create({
  preview: { backgroundColor: C.paper, borderRadius: 8, maxHeight: PREVIEW_HEIGHT, overflow: "hidden" },
  fade: { position: "absolute", bottom: 0, left: 0, right: 0, height: FADE_HEIGHT },
  body: { color: C.paperInk, fontSize: 17, lineHeight: 32 },
  date: { color: C.paperMuted, fontSize: 12, lineHeight: 20 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: C.paperFooterRule, marginTop: 20 },
  readingPaper: { padding: 28, borderRadius: 8, backgroundColor: C.paper, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: C.paperBorder },
  readingFooter: { paddingTop: 28 },
});

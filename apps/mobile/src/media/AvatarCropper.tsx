import { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Check, Minus, Plus, RotateCcw } from "lucide-react-native";
import { ActionButton, ScreenHeader } from "../ui/controls";
import { type Colors, UI } from "../ui/theme";
import { useAppTheme, useThemedStyles } from "../ui/ThemeProvider";
import { problemMessage } from "../ui/presentation";
import type { UploadImageInput } from "../api/letterApi";
import {
  constrainCrop,
  cropScale,
  exportAvatar,
  INITIAL_CROP,
  type CropImage,
  type CropPosition,
} from "./avatarCrop";

function touchGeometry(event: GestureResponderEvent) {
  const touches = event.nativeEvent.touches;
  const a = touches[0];
  const b = touches[1];
  if (!a) return null;
  return {
    count: b ? 2 : 1,
    x: b ? (a.pageX + b.pageX) / 2 : a.pageX,
    y: b ? (a.pageY + b.pageY) / 2 : a.pageY,
    distance: b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0,
  };
}

export function AvatarCropper({
  image,
  onCancel,
  onConfirm,
}: {
  image: CropImage;
  onCancel: () => void;
  onConfirm: (input: UploadImageInput) => Promise<void>;
}) {
  const { colors: C } = useAppTheme();
  const styles = useThemedStyles(createStyles);

  const window = useWindowDimensions();
  const diameter = Math.max(100, Math.min(360, window.width - 48, window.height * 0.48));
  const [position, setPosition] = useState<CropPosition>(INITIAL_CROP);
  const current = useRef(INITIAL_CROP);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [done, setDone] = useState(false);
  const start = useRef<{
    touch: NonNullable<ReturnType<typeof touchGeometry>>;
    position: CropPosition;
  } | null>(null);
  const center = useRef({ x: 0, y: 0 });
  const viewport = useRef<View>(null);
  function update(next: CropPosition) {
    const bounded = constrainCrop(image, diameter, next);
    current.current = bounded;
    setPosition(bounded);
  }
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !saving.current,
        onMoveShouldSetPanResponder: () => !saving.current,
        onPanResponderGrant: (event) => {
          viewport.current?.measureInWindow((x, y, width, height) => {
            center.current = { x: x + width / 2, y: y + height / 2 };
          });
          const touch = touchGeometry(event);
          start.current = touch ? { touch, position: current.current } : null;
        },
        onPanResponderMove: (event) => {
          if (saving.current) return;
          const touch = touchGeometry(event);
          if (!touch) return;
          const previous = start.current;
          if (!previous || previous.touch.count !== touch.count) {
            start.current = { touch, position: current.current };
            return;
          }
          const zoom = Math.max(
            1,
            Math.min(
              5,
              previous.position.zoom *
                (touch.count === 2 && previous.touch.distance > 0
                  ? touch.distance / previous.touch.distance
                  : 1)
            )
          );
          const ratio = zoom / previous.position.zoom;
          update({
            zoom,
            x:
              (previous.position.x - (previous.touch.x - center.current.x)) * ratio +
              (touch.x - center.current.x),
            y:
              (previous.position.y - (previous.touch.y - center.current.y)) * ratio +
              (touch.y - center.current.y),
          });
        },
        onPanResponderRelease: () => {
          start.current = null;
        },
        onPanResponderTerminate: () => {
          start.current = null;
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [image, diameter]
  );

  async function confirm() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await onConfirm(await exportAvatar(image, diameter, current.current));
      setDone(true);
      onCancel();
    } catch (failure) {
      Alert.alert("头像未更新", problemMessage(failure));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const scale = cropScale(image, diameter, position.zoom);
  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => {
        if (!saving.current) onCancel();
      }}
    >
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <ScreenHeader
            title="裁剪头像"
            backLabel="取消裁剪"
            onBack={() => {
              if (!saving.current) onCancel();
            }}
          />
        </View>
        <View style={styles.stage}>
          <View
            ref={viewport}
            collapsable={false}
            testID="avatar-crop-circle"
            style={[
              styles.circle,
              { width: diameter, height: diameter, borderRadius: diameter / 2 },
            ]}
            {...responder.panHandlers}
          >
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              <Image
                source={{ uri: image.uri }}
                resizeMode="stretch"
                style={{
                  position: "absolute",
                  width: image.width * scale,
                  height: image.height * scale,
                  left: (diameter - image.width * scale) / 2 + position.x,
                  top: (diameter - image.height * scale) / 2 + position.y,
                }}
              />
            </View>
          </View>
        </View>
        <View style={styles.controls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="缩小头像"
            disabled={busy || position.zoom <= 1}
            style={styles.tool}
            onPress={() => update({ ...current.current, zoom: current.current.zoom / 1.2 })}
          >
            <Minus color={C.ink} size={22} />
          </Pressable>
          <Text style={styles.zoom}>{position.zoom.toFixed(1)}×</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="放大头像"
            disabled={busy || position.zoom >= 5}
            style={styles.tool}
            onPress={() => update({ ...current.current, zoom: current.current.zoom * 1.2 })}
          >
            <Plus color={C.ink} size={22} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="重置裁剪"
            disabled={busy}
            style={styles.tool}
            onPress={() => update(INITIAL_CROP)}
          >
            <RotateCcw color={C.muted} size={22} />
          </Pressable>
        </View>
        <View style={styles.footer}>
          {busy ? <ActivityIndicator color={C.green} /> : null}
          <ActionButton
            title={busy ? "正在更新…" : "使用头像"}
            icon={Check}
            disabled={busy || done}
            onPress={() => void confirm()}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const createStyles = (C: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.canvas },
  header: { paddingHorizontal: UI.gutter },
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  circle: { overflow: "hidden", backgroundColor: C.surface },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingVertical: 20,
  },
  tool: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: C.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  zoom: { width: 48, textAlign: "center", color: C.muted, fontSize: 14 },
  footer: { paddingHorizontal: UI.gutter, paddingBottom: 20, gap: 16 },
});

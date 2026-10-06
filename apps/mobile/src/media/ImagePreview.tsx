import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Modal,
  PanResponder,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from "react-native";
import {
  constrainPreview,
  ORIGINAL_PREVIEW,
  previewFrame,
  pinchPreview,
  previewDismissDistance,
  zoomPreviewAt,
  type PreviewPosition,
} from "./previewGeometry";

const DOUBLE_TAP_MS = 350;
const DRAG_THRESHOLD = 12;

export interface PreviewGallery {
  index: number;
  count: number;
  onChange: (index: number) => void;
}

function touchGeometry(event: GestureResponderEvent) {
  const [a, b] = event.nativeEvent.touches;
  if (!a || !Number.isFinite(a.pageX) || !Number.isFinite(a.pageY)) return null;
  if (b && (!Number.isFinite(b.pageX) || !Number.isFinite(b.pageY))) return null;
  return {
    count: b ? 2 : 1,
    x: b ? (a.pageX + b.pageX) / 2 : a.pageX,
    y: b ? (a.pageY + b.pageY) / 2 : a.pageY,
    distance: b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0,
  };
}

export function ImagePreview({
  children,
  aspectRatio,
  onClose,
  gallery,
}: {
  children: ReactNode;
  aspectRatio: number;
  onClose: () => void;
  gallery?: PreviewGallery;
}) {
  const [position, setPosition] = useState(ORIGINAL_PREVIEW);
  const current = useRef(ORIGINAL_PREVIEW);
  const viewport = useRef({ width: 0, height: 0 });
  const viewportView = useRef<View>(null);
  const origin = useRef({ x: 0, y: 0 });
  const scale = useRef(new Animated.Value(1)).current;
  const panX = useRef(new Animated.Value(0)).current;
  const panY = useRef(new Animated.Value(0)).current;
  const dismissX = useRef(new Animated.Value(0)).current;
  const dismissY = useRef(new Animated.Value(0)).current;
  const close = useRef(onClose);
  close.current = onClose;
  const pages = useRef(gallery);
  pages.current = gallery;
  const ratio = useRef(aspectRatio);
  ratio.current = aspectRatio;
  const closed = useRef(false);
  const pendingTap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapEpoch = useRef(0);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const touchSession = useRef({ tracked: false, active: 0, multiTouch: false, cancelled: false });
  const gesture = useRef<{
    x: number;
    y: number;
    pageX: number;
    pageY: number;
    startedAt: number;
    moved: boolean;
    position: PreviewPosition;
    touch: NonNullable<ReturnType<typeof touchGeometry>>;
    dragDistance: number;
    multiTouch: boolean;
    axis: "horizontal" | "vertical" | null;
    dx: number;
    dy: number;
  } | null>(null);

  function cancelTap() {
    tapEpoch.current++;
    if (pendingTap.current !== null) clearTimeout(pendingTap.current);
    pendingTap.current = null;
  }

  function resetDismiss(animate = false) {
    for (const offset of [dismissX, dismissY]) {
      offset.stopAnimation();
      if (animate) {
        Animated.timing(offset, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }).start();
      } else offset.setValue(0);
    }
  }

  function observeMultiTouch(event: GestureResponderEvent) {
    if (event.nativeEvent.touches.length < 2 && (event.nativeEvent.changedTouches?.length ?? 0) < 2)
      return;
    touchSession.current.multiTouch = true;
    cancelTap();
    lastTap.current = null;
    if (gesture.current) {
      gesture.current.multiTouch = true;
      gesture.current.moved = true;
      gesture.current.dragDistance = 0;
    }
    resetDismiss();
  }

  function trackTouchStart(event: GestureResponderEvent) {
    const session = touchSession.current;
    const count = event.nativeEvent.touches.length;
    if (count === 0) return;
    if (session.active === 0) {
      session.multiTouch = false;
      session.cancelled = false;
    }
    session.tracked = true;
    session.active = count;
    cancelTap();
    observeMultiTouch(event);
  }

  function trackTouches(event: GestureResponderEvent) {
    touchSession.current.tracked = true;
    touchSession.current.active = event.nativeEvent.touches.length;
    observeMultiTouch(event);
  }

  function cancelTouches() {
    touchSession.current.active = 0;
    touchSession.current.cancelled = true;
    cancelTap();
    lastTap.current = null;
  }

  function update(next: PreviewPosition, animate = false) {
    const { width, height } = viewport.current;
    const bounded = constrainPreview(next, width, height, ratio.current);
    scale.stopAnimation();
    panX.stopAnimation();
    panY.stopAnimation();
    resetDismiss();
    current.current = bounded;
    setPosition(bounded);
    // Native Animated memoizes the graph without static transform numbers.
    panX.setValue(bounded.x);
    panY.setValue(bounded.y);
    if (animate) {
      Animated.timing(scale, {
        toValue: bounded.zoom,
        duration: 180,
        useNativeDriver: true,
      }).start();
    } else scale.setValue(bounded.zoom);
  }

  function resetPreview() {
    // onShow can arrive after the first touch during the modal's entrance animation.
    if (touchSession.current.tracked) return;
    cancelTap();
    gesture.current = null;
    lastTap.current = null;
    closed.current = false;
    touchSession.current = { tracked: false, active: 0, multiTouch: false, cancelled: false };
    update(ORIGINAL_PREVIEW);
  }

  function requestClose() {
    if (closed.current) return;
    closed.current = true;
    cancelTap();
    gesture.current = null;
    lastTap.current = null;
    scale.stopAnimation();
    panX.stopAnimation();
    panY.stopAnimation();
    dismissX.stopAnimation();
    dismissY.stopAnimation();
    close.current();
  }

  function changePage(index: number) {
    const page = pages.current;
    if (!page || index < 0 || index >= page.count || index === page.index) {
      resetDismiss(true);
      return;
    }
    cancelTap();
    lastTap.current = null;
    gesture.current = null;
    update(ORIGINAL_PREVIEW);
    pages.current = { ...page, index };
    page.onChange(index);
  }

  function toggleZoom(x: number, y: number) {
    cancelTap();
    lastTap.current = null;
    resetDismiss();
    const { width, height } = viewport.current;
    const frame = previewFrame(width, height, ratio.current);
    if (
      current.current.zoom === 1 &&
      (Math.abs(x - width / 2) > frame.width / 2 || Math.abs(y - height / 2) > frame.height / 2)
    ) {
      requestClose();
      return;
    }
    update(
      current.current.zoom > 1
        ? ORIGINAL_PREVIEW
        : zoomPreviewAt(x, y, width, height, ratio.current),
      true
    );
  }

  function beginGesture(event: GestureResponderEvent, recovered = false) {
    cancelTap();
    scale.stopAnimation();
    resetDismiss();
    const previous = gesture.current;
    if (!touchSession.current.tracked && !previous) {
      touchSession.current.multiTouch = false;
      touchSession.current.cancelled = false;
    }
    observeMultiTouch(event);
    const touch = touchGeometry(event);
    if (!touch || closed.current) return;
    viewportView.current?.measureInWindow((x, y) => {
      origin.current = { x, y };
    });
    gesture.current = {
      x: touch.x - origin.current.x,
      y: touch.y - origin.current.y,
      pageX: touch.x,
      pageY: touch.y,
      startedAt: Date.now(),
      moved:
        recovered ||
        touchSession.current.multiTouch ||
        touchSession.current.cancelled ||
        touch.count > 1,
      position: current.current,
      touch,
      dragDistance: 0,
      multiTouch: touchSession.current.multiTouch || touch.count > 1,
      axis: null,
      dx: 0,
      dy: 0,
    };
  }

  function rebaseTouches(event: GestureResponderEvent) {
    if (touchSession.current.tracked)
      touchSession.current.active = event.nativeEvent.touches.length;
    observeMultiTouch(event);
    const touch = touchGeometry(event);
    const start = gesture.current;
    if (!touch) return;
    if (!start) {
      beginGesture(event, true);
      return;
    }
    if (touch.count === start.touch.count) return;
    start.moved = true;
    start.touch = touch;
    start.position = current.current;
    start.dragDistance = 0;
    start.axis = null;
    start.dx = 0;
    start.dy = 0;
    start.multiTouch ||= touch.count > 1;
    cancelTap();
    lastTap.current = null;
    resetDismiss();
  }

  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      cancelTap();
      gesture.current = null;
      lastTap.current = null;
      scale.stopAnimation();
      panX.stopAnimation();
      panY.stopAnimation();
      dismissX.stopAnimation();
      dismissY.stopAnimation();
    };
  }, [scale, panX, panY, dismissX, dismissY]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (event) => {
          trackTouchStart(event);
          return !closed.current;
        },
        onMoveShouldSetPanResponder: (event) => {
          trackTouches(event);
          return !closed.current;
        },
        // Preserve retry buttons for one finger; the viewer owns multi-touch gestures.
        onStartShouldSetPanResponderCapture: (event) => {
          trackTouchStart(event);
          return !closed.current && event.nativeEvent.touches.length > 1;
        },
        onMoveShouldSetPanResponderCapture: (event) => {
          trackTouches(event);
          return !closed.current && event.nativeEvent.touches.length > 1;
        },
        onPanResponderTerminationRequest: () => gesture.current === null,
        onPanResponderGrant: (event) => {
          beginGesture(event, gesture.current !== null);
        },
        onPanResponderStart: rebaseTouches,
        onPanResponderEnd: rebaseTouches,
        onPanResponderMove: (event) => {
          observeMultiTouch(event);
          const start = gesture.current;
          const touch = touchGeometry(event);
          if (!touch || closed.current) return;
          if (!start) {
            beginGesture(event, true);
            return;
          }
          if (start.touch.count !== touch.count) {
            rebaseTouches(event);
            return;
          }
          const dx = touch.x - start.touch.x;
          const dy = touch.y - start.touch.y;
          if (touch.count > 1 || Math.hypot(dx, dy) > DRAG_THRESHOLD) {
            start.moved = true;
            lastTap.current = null;
            cancelTap();
          }
          if (touch.count === 2) {
            const { width, height } = viewport.current;
            start.multiTouch = true;
            start.dragDistance = 0;
            update(
              pinchPreview(
                start.position,
                {
                  ...start.touch,
                  x: start.touch.x - origin.current.x,
                  y: start.touch.y - origin.current.y,
                },
                { ...touch, x: touch.x - origin.current.x, y: touch.y - origin.current.y },
                width,
                height,
                ratio.current
              )
            );
          } else if (start.moved && start.position.zoom > 1) {
            update({
              ...start.position,
              x: start.position.x + dx,
              y: start.position.y + dy,
            });
          } else if (start.moved && !start.multiTouch) {
            start.dx = dx;
            start.dy = dy;
            start.dragDistance = Math.hypot(dx, dy);
            if (pages.current) {
              start.axis ??= Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
              dismissX.setValue(start.axis === "horizontal" ? dx : 0);
              dismissY.setValue(start.axis === "vertical" ? dy : 0);
            } else {
              dismissX.setValue(dx);
              dismissY.setValue(dy);
            }
          }
        },
        onPanResponderRelease: (event) => {
          if (touchSession.current.tracked)
            touchSession.current.active = event.nativeEvent.touches.length;
          observeMultiTouch(event);
          const start = gesture.current;
          gesture.current = null;
          const protectedTouch =
            start?.multiTouch || touchSession.current.multiTouch || touchSession.current.cancelled;
          if (!touchSession.current.tracked) {
            touchSession.current.multiTouch = false;
            touchSession.current.cancelled = false;
          }
          if (protectedTouch) {
            cancelTap();
            lastTap.current = null;
            resetDismiss(true);
            return;
          }
          if (!start || start.moved || Date.now() - start.startedAt > 400) {
            lastTap.current = null;
            if (pages.current && start?.position.zoom === 1) {
              if (start.axis === "horizontal") {
                const threshold = Math.max(56, Math.min(120, viewport.current.width * 0.2));
                if (Math.abs(start.dx) >= threshold) {
                  changePage(pages.current.index + (start.dx < 0 ? 1 : -1));
                } else resetDismiss(true);
              } else if (
                start.axis === "vertical" &&
                Math.abs(start.dy) >= previewDismissDistance(viewport.current.height)
              ) {
                requestClose();
              } else resetDismiss(true);
              return;
            }
            if (
              start?.position.zoom === 1 &&
              !start.multiTouch &&
              start.dragDistance >= previewDismissDistance(viewport.current.height)
            ) {
              cancelTap();
              requestClose();
            } else {
              resetDismiss(true);
            }
            return;
          }
          const previous = lastTap.current;
          const now = Date.now();
          if (
            previous &&
            start.startedAt - previous.time <= DOUBLE_TAP_MS &&
            Math.hypot(start.pageX - previous.x, start.pageY - previous.y) <= 48
          ) {
            toggleZoom(start.x, start.y);
          } else {
            lastTap.current = { time: now, x: start.pageX, y: start.pageY };
            const epoch = tapEpoch.current;
            pendingTap.current = setTimeout(() => {
              if (epoch !== tapEpoch.current) return;
              pendingTap.current = null;
              lastTap.current = null;
              if (
                touchSession.current.multiTouch ||
                touchSession.current.cancelled ||
                touchSession.current.active > 0 ||
                gesture.current !== null
              )
                return;
              requestClose();
            }, DOUBLE_TAP_MS);
          }
        },
        onPanResponderTerminate: () => {
          cancelTouches();
          gesture.current = null;
          lastTap.current = null;
          cancelTap();
          resetDismiss(true);
        },
      }),
    [scale, panX, panY, dismissX, dismissY]
  );

  return (
    <Modal
      visible
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onShow={resetPreview}
      onRequestClose={requestClose}
    >
      <View
        ref={viewportView}
        collapsable={false}
        testID="image-preview-viewport"
        style={styles.viewport}
        accessible
        accessibilityLabel="图片全屏预览"
        accessibilityActions={[
          { name: "dismiss", label: "关闭预览" },
          { name: "activate", label: position.zoom > 1 ? "恢复图片大小" : "放大图片" },
          ...(gallery && gallery.index > 0 ? [{ name: "decrement", label: "上一张" }] : []),
          ...(gallery && gallery.index < gallery.count - 1
            ? [{ name: "increment", label: "下一张" }]
            : []),
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "dismiss") requestClose();
          if (event.nativeEvent.actionName === "increment" && pages.current)
            changePage(pages.current.index + 1);
          if (event.nativeEvent.actionName === "decrement" && pages.current)
            changePage(pages.current.index - 1);
          if (event.nativeEvent.actionName === "activate") {
            const { width, height } = viewport.current;
            toggleZoom(width / 2, height / 2);
          }
        }}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          if (width === viewport.current.width && height === viewport.current.height) return;
          viewport.current = { width, height };
          viewportView.current?.measureInWindow((x, y) => {
            origin.current = { x, y };
          });
          update(ORIGINAL_PREVIEW);
        }}
        {...responder.panHandlers}
        onTouchStart={trackTouchStart}
        onTouchMove={trackTouches}
        onTouchEnd={trackTouches}
        onTouchCancel={cancelTouches}
      >
        <Animated.View
          style={[
            styles.image,
            {
              transform: [
                { translateX: panX },
                { translateY: panY },
                { translateX: dismissX },
                { translateY: dismissY },
                { scale },
              ],
            },
          ]}
        >
          {children}
        </Animated.View>
        {gallery && gallery.count > 1 ? (
          <View pointerEvents="none" style={styles.pageIndicator}>
            <Text style={styles.pageText} accessibilityLiveRegion="polite">
              {gallery.index + 1} / {gallery.count}
            </Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  viewport: { flex: 1, backgroundColor: "#111315", overflow: "hidden" },
  image: { width: "100%", height: "100%" },
  pageIndicator: { position: "absolute", bottom: 48, alignSelf: "center" },
  pageText: { color: "#ffffff", fontSize: 14 },
});

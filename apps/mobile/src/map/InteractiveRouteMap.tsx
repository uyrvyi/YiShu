import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from "react-native";
import { Earth, RefreshCw, ScanLine } from "lucide-react-native";
import WebView from "react-native-webview";
import type { RouteMapViewParsed } from "@yishu/shared";
import { RouteMap } from "./RouteMap";
import { buildLocalMapHtml, mapThemeScript, mapUpdateScript } from "./localMapHtml";
import { mapDetailScript, mapDetailsForViewport, parseMapDetailRequest } from "./mapDetails";
import { type Colors, UI } from "../ui/theme";
import { useAppTheme, useThemedStyles } from "../ui/ThemeProvider";

interface InteractiveRouteMapProps {
  view: RouteMapViewParsed;
  progress?: { title: string; detail: string };
  onInteractionChange?: (active: boolean) => void;
}

export function InteractiveRouteMap({
  view,
  progress,
  onInteractionChange,
}: InteractiveRouteMapProps) {
  const { colors: C } = useAppTheme();
  const { scheme } = useAppTheme();
  const styles = useThemedStyles(createStyles);

  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [progressHeight, setProgressHeight] = useState(64);
  const [attempt, setAttempt] = useState(0);
  const [failureReason, setFailureReason] = useState("");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const webview = useRef<WebView>(null);
  const documentReady = useRef(false);
  const interacting = useRef(false);
  const beginMapTouch = () => {
    if (!interacting.current) {
      interacting.current = true;
      onInteractionChange?.(true);
    }
  };
  const releaseMapTouch = () => {
    if (interacting.current) {
      interacting.current = false;
      onInteractionChange?.(false);
    }
  };
  const finishMapTouch = (event: GestureResponderEvent) => {
    if (event.nativeEvent.touches.length === 0) releaseMapTouch();
  };
  const topInset = progress ? progressHeight + 24 : 18;
  const html = useMemo(() => {
    const baseUrl = process.env.EXPO_PUBLIC_MAP_TILE_BASE_URL?.trim();
    try {
      return buildLocalMapHtml(baseUrl ? { baseUrl } : undefined);
    } catch {
      return buildLocalMapHtml();
    }
  }, []);
  const source = useMemo(() => ({ html, baseUrl: "https://yishu.local/" }), [html]);
  const progressView = progress ? (
    <View
      style={styles.progress}
      onLayout={(event) => setProgressHeight(event.nativeEvent.layout.height)}
    >
      <Text style={styles.progressTitle}>{progress.title}</Text>
      <Text style={styles.progressDetail}>{progress.detail}</Text>
    </View>
  ) : null;

  useEffect(() => {
    setFailed(false);
    setReady(false);
    setFailureReason("");
    documentReady.current = false;
  }, [html, attempt]);

  useEffect(() => {
    if (!html || ready || failed || !size) return;
    const timeout = setTimeout(() => {
      setFailureReason("地图绘制超时");
      setFailed(true);
    }, 10000);
    return () => clearTimeout(timeout);
  }, [html, ready, failed, attempt, size]);

  useEffect(() => {
    if (documentReady.current) webview.current?.injectJavaScript(mapUpdateScript(view, topInset));
  }, [view, topInset, ready]);

  useEffect(() => {
    if (documentReady.current) webview.current?.injectJavaScript(mapThemeScript(scheme));
  }, [scheme, ready]);

  useEffect(() => {
    const release = () => {
      if (interacting.current) {
        interacting.current = false;
        onInteractionChange?.(false);
      }
    };
    if (failed) release();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") release();
    });
    return () => {
      subscription.remove();
      release();
    };
  }, [onInteractionChange, failed, attempt]);

  if (failed)
    return (
      <View>
        {progress ? (
          <View style={styles.offlineProgress}>
            <Text style={styles.progressTitle}>{progress.title}</Text>
            <Text style={styles.progressDetail}>{progress.detail}</Text>
          </View>
        ) : null}
        <RouteMap view={view} />
        <View style={styles.mapStatus}>
          <Text style={styles.statusText}>静态运输示意图</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="重新绘制运输地图"
            onPress={() => {
              setFailed(false);
              setReady(false);
              setAttempt((value) => value + 1);
            }}
            style={styles.retry}
          >
            <RefreshCw size={18} color={C.green} />
          </Pressable>
        </View>
        {failureReason ? <Text style={styles.statusText}>{failureReason}</Text> : null}
      </View>
    );

  return (
    <View
      style={styles.container}
      accessibilityLabel="可缩放的信件运输地图"
      collapsable={false}
      onStartShouldSetResponderCapture={() => {
        // Lock the parent before movement, without stealing WebView's native gesture.
        beginMapTouch();
        return false;
      }}
      onTouchStart={beginMapTouch}
      onTouchMove={beginMapTouch}
      onTouchEnd={finishMapTouch}
      onTouchCancel={finishMapTouch}
      onLayout={({ nativeEvent: { layout } }) => {
        if (layout.width > 0 && layout.height > 0)
          setSize((current) =>
            current?.width === layout.width && current?.height === layout.height
              ? current
              : { width: layout.width, height: layout.height }
          );
      }}
    >
      {size ? (
        <WebView
          ref={webview}
          key={attempt}
          containerStyle={[styles.webviewContainer, size]}
          style={[styles.webview, size]}
          source={source}
          originWhitelist={["*"]}
          javaScriptEnabled
          domStorageEnabled
          scrollEnabled={false}
          nestedScrollEnabled
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          bounces={false}
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank" || request.url === "https://yishu.local/"
          }
          onMessage={(event) => {
            const message = event.nativeEvent.data;
            const detailRequest = parseMapDetailRequest(message);
            if (detailRequest) {
              try {
                webview.current?.injectJavaScript(
                  mapDetailScript(mapDetailsForViewport(detailRequest))
                );
              } catch (error) {
                console.warn("Map detail pack unavailable", error);
                webview.current?.injectJavaScript("window.yishuMapDetailsUnavailable();true;");
              }
              return;
            }
            if (message === "document-ready") {
              documentReady.current = true;
              webview.current?.injectJavaScript(mapThemeScript(scheme));
              webview.current?.injectJavaScript(mapUpdateScript(view, topInset));
            }
            if (message === "ready") setReady(true);
            if (message === "error" || message.startsWith("error:")) {
              setFailureReason("地图绘制失败");
              setFailed(true);
            }
          }}
          onError={() => {
            setFailureReason("网页连接失败");
            setFailed(true);
          }}
          onHttpError={() => {
            setFailureReason("地图服务请求失败");
            setFailed(true);
          }}
          onContentProcessDidTerminate={() => {
            setFailureReason("地图渲染进程中断");
            setFailed(true);
          }}
        />
      ) : null}
      {progressView}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="显示完整可见路线"
        onPress={() => webview.current?.injectJavaScript("window.yishuMapFit();true;")}
        style={styles.fit}
      >
        <ScanLine size={20} color={C.ink} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="查看全国底图"
        onPress={() => webview.current?.injectJavaScript("window.yishuMapOverview();true;")}
        style={[styles.fit, { top: 60 }]}
      >
        <Earth size={20} color={C.ink} />
      </Pressable>
      {view.districtLocationsUnavailable?.length ? (
        <View style={styles.coverage}>
          <Text style={styles.statusText}>
            区县位置暂缺：{view.districtLocationsUnavailable.join("、")}
          </Text>
        </View>
      ) : null}
      {!ready ? (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator size="small" color={C.green} />
          <Text style={styles.statusText}>地图绘制中</Text>
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (C: Colors) => StyleSheet.create({
  container: { width: "100%", aspectRatio: 5 / 4, overflow: "hidden", borderRadius: UI.radius },
  progress: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 64,
    padding: 12,
    borderRadius: UI.controlRadius,
    backgroundColor: C.surface,
  },
  offlineProgress: { marginBottom: 12 },
  progressTitle: { color: C.green, fontSize: 13, fontWeight: "600", lineHeight: 20 },
  progressDetail: { color: C.ink, fontSize: 12, lineHeight: 18, marginTop: 3 },
  webviewContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    flex: 0,
  },
  webview: {
    flex: 0,
    backgroundColor: "transparent",
  },
  mapStatus: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  statusText: { fontSize: 12, color: C.muted },
  retry: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: C.surface,
  },
  loading: {
    position: "absolute",
    bottom: 36,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.surface,
    padding: 12,
    borderRadius: 22,
  },
  fit: {
    position: "absolute",
    top: 12,
    right: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  coverage: {
    position: "absolute",
    bottom: 24,
    left: 12,
    right: 64,
    backgroundColor: C.surface,
    padding: 8,
    borderRadius: UI.controlRadius,
  },
});

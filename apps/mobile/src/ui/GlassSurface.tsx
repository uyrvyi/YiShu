import { useEffect, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import { BlurView } from "expo-blur";
import Constants from "expo-constants";
import { type Colors } from "./theme";
import { useAppTheme, useThemedStyles } from "./ThemeProvider";

export function glassMaterial(platform: string, available: boolean, reduceTransparency: boolean) {
  if (reduceTransparency) return "opaque";
  if (platform === "ios" && available) return "glass";
  return platform === "ios" ? "blur" : "opaque";
}

export async function getGlassDiagnostics(): Promise<string> {
  const api = Platform.OS === "ios" && isGlassEffectAPIAvailable();
  const application = Platform.OS === "ios" && isLiquidGlassAvailable();
  const reduced = await AccessibilityInfo.isReduceTransparencyEnabled();
  const material = glassMaterial(Platform.OS, api && application, reduced);
  return [
    `系统：${Platform.OS} ${Platform.Version}`,
    `运行环境：${Constants.executionEnvironment}`,
    `原生应用版本：${Constants.nativeAppVersion ?? "未知"}`,
    `玻璃 API：${api ? "可用" : "不可用"}`,
    `应用玻璃支持：${application ? "可用" : "不可用"}`,
    `降低透明度：${reduced ? "开启" : "关闭"}`,
    `选择的材质：${material === "glass" ? "原生 Liquid Glass" : material === "blur" ? "普通模糊回退" : "实色回退"}`,
  ].join("\n");
}

export function GlassSurface({
  children,
  style,
  appearance = "glass",
}: {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
  appearance?: "glass" | "clear" | "frosted";
}) {
  const { colors: C } = useAppTheme();
  const { scheme } = useAppTheme();
  const styles = useThemedStyles(createStyles);

  // Start opaque until the system accessibility preference has been read.
  const [reduceTransparency, setReduceTransparency] = useState(true);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    let active = true;
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      (value) => {
        if (active) setReduceTransparency(value);
      }
    );
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => {
        if (active) setReduceTransparency(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  const available =
    Platform.OS === "ios" && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
  const material = glassMaterial(Platform.OS, available, reduceTransparency);
  const radius = StyleSheet.flatten(style)?.borderRadius ?? 0;
  const layerStyle = [styles.layer, { borderRadius: radius, borderCurve: "continuous" as const }];
  return (
    <View
      collapsable={false}
      style={[style, { backgroundColor: material === "opaque" ? C.surface : "transparent" }]}
      onLayout={({ nativeEvent: { layout } }) => {
        if (layout.width > 0 && layout.height > 0) {
          setSize((current) =>
            current?.width === layout.width && current?.height === layout.height
              ? current
              : { width: layout.width, height: layout.height }
          );
        }
      }}
    >
      {material === "glass" && size && appearance !== "frosted" ? (
        <GlassView
          key={`${size.width}:${size.height}`}
          pointerEvents="none"
          glassEffectStyle={appearance === "clear" ? "clear" : "regular"}
          colorScheme={scheme}
          style={[layerStyle, { width: size.width, height: size.height }]}
        />
      ) : material !== "opaque" ? (
        <BlurView
          pointerEvents="none"
          tint={scheme === "dark" ? "systemThinMaterialDark" : "systemThinMaterialLight"}
          intensity={appearance === "frosted" ? 80 : 55}
          style={[layerStyle, { overflow: "hidden" }]}
        />
      ) : null}
      {children}
    </View>
  );
}

const createStyles = (C: Colors) => StyleSheet.create({
  layer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
});

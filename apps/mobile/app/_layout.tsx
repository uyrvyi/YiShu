import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

/**
 * 驿书 V1 Mobile 根布局。
 * Phase 1 仅建立 Expo Router 骨架，不包含任何业务路由。
 */
export default function RootLayout(): React.JSX.Element {
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}

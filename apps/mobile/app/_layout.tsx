import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

/**
 * 驿书 V1 Mobile 根布局。
 * 当前承载 Phase 2 认证入口与 Phase 3 基础信件路由。
 */
export default function RootLayout(): React.JSX.Element {
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}

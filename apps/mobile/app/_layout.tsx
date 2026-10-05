import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PushRegistration } from "../src/push/PushRegistration";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * 驿书 V1 Mobile 根布局。
 * 当前承载 Phase 2 认证入口与 Phase 3 基础信件路由。
 */
export default function RootLayout(): React.JSX.Element {
  return (
    <>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <PushRegistration />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="letters/index" options={{ animation: "none" }} />
          <Stack.Screen name="me" options={{ animation: "none" }} />
        </Stack>
      </SafeAreaProvider>
    </>
  );
}

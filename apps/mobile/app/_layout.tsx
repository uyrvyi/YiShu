import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PushRegistration } from "../src/push/PushRegistration";
import { useSyncExternalStore } from "react";
import { getSessionVersion, isAuthenticated, subscribeSession } from "../src/api";
import { EncryptionBootstrap } from "../src/e2ee/EncryptionBootstrap";

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
  const version = useSyncExternalStore(subscribeSession, getSessionVersion, getSessionVersion);
  const authenticated = useSyncExternalStore(subscribeSession, isAuthenticated, isAuthenticated);
  return (
    <>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <PushRegistration />
        <EncryptionBootstrap authenticated={authenticated} version={version} />
        <Stack key={version} screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Protected guard={authenticated}>
            <Stack.Screen name="letters/index" options={{ animation: "none" }} />
            <Stack.Screen name="letters/new" />
            <Stack.Screen name="letters/[trackingNo]" />
            <Stack.Screen name="letters/[trackingNo]/logistics" />
            <Stack.Screen name="letters/[trackingNo]/map" />
            <Stack.Screen name="me" options={{ animation: "none" }} />
            <Stack.Screen name="profile" />
            <Stack.Screen name="encryption" />
          </Stack.Protected>
        </Stack>
      </SafeAreaProvider>
    </>
  );
}

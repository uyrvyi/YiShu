import { Stack, ThemeProvider as NavigationThemeProvider, DefaultTheme, DarkTheme } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PushRegistration } from "../src/push/PushRegistration";
import { useSyncExternalStore } from "react";
import { getSessionVersion, isAuthenticated, subscribeSession } from "../src/api";
import { EncryptionBootstrap } from "../src/e2ee/EncryptionBootstrap";
import { ThemeProvider, useAppTheme } from "../src/ui/ThemeProvider";

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
  return <SafeAreaProvider><ThemeProvider><RootNavigation /></ThemeProvider></SafeAreaProvider>;
}

function RootNavigation() {
  const { colors, scheme } = useAppTheme();
  const navigationTheme = scheme === "dark" ? DarkTheme : DefaultTheme;
  const version = useSyncExternalStore(subscribeSession, getSessionVersion, getSessionVersion);
  const authenticated = useSyncExternalStore(subscribeSession, isAuthenticated, isAuthenticated);
  return (
    <>
      <NavigationThemeProvider value={{ ...navigationTheme, colors: { ...navigationTheme.colors,
        background: colors.canvas, card: colors.surface, text: colors.ink, border: colors.line, primary: colors.green } }}>
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        <PushRegistration />
        <EncryptionBootstrap authenticated={authenticated} version={version} />
        <Stack key={version} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }}>
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
            <Stack.Screen name="appearance" />
          </Stack.Protected>
        </Stack>
      </NavigationThemeProvider>
    </>
  );
}

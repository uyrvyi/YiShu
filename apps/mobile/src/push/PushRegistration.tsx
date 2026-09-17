import { useEffect, useRef, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import {
  getSessionVersion,
  isAuthenticated,
  registerDeviceForSession,
  subscribeSession,
} from "../api";
import { refetchVisibleScreens } from "../refresh/usePolling";
import { readPushToken } from "./tokenStorage";

/** Enhancement only: denied permission / missing EAS project / offline never block Auth. */
export function PushRegistration(): null {
  const generation = useSyncExternalStore(subscribeSession, getSessionVersion, getSessionVersion);
  const router = useRouter();
  const lastResponse = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const register = async () => {
      if (!isAuthenticated() || !["ios", "android"].includes(Platform.OS)) return;
      // Repair a failed offline logout before permission/token acquisition can return early.
      const retained = await readPushToken();
      if (retained && !cancelled)
        await registerDeviceForSession(retained, Platform.OS as "ios" | "android", generation);
      if (Platform.OS === "android")
        await Notifications.setNotificationChannelAsync("default", {
          name: "驿书",
          importance: Notifications.AndroidImportance.DEFAULT,
        });
      const permission = await Notifications.requestPermissionsAsync();
      if (!permission.granted || cancelled) return;
      const projectId: unknown =
        Constants.easConfig?.projectId ??
        Constants.expoConfig?.extra?.eas?.projectId ??
        process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
      if (typeof projectId !== "string" || !projectId) return;
      const token = await Notifications.getExpoPushTokenAsync({ projectId });
      if (!cancelled)
        await registerDeviceForSession(token.data, Platform.OS as "ios" | "android", generation);
    };
    void register().catch(() => {}); // deliberately no token/provider details in logs
    const tokenChange = Notifications.addPushTokenListener(() => {
      void register().catch(() => {});
    });
    return () => {
      cancelled = true;
      tokenChange.remove();
    };
  }, [generation]);
  useEffect(() => {
    let cancelled = false;
    const received = Notifications.addNotificationReceivedListener(() => {
      if (isAuthenticated()) refetchVisibleScreens();
    });
    const handleResponse = (response: Notifications.NotificationResponse) => {
      if (cancelled || !isAuthenticated() || generation !== getSessionVersion()) return;
      const identifier = response.notification.request.identifier;
      if (lastResponse.current === identifier) return;
      lastResponse.current = identifier;
      const trackingNo: unknown = response.notification.request.content.data?.trackingNo;
      // Notification is never truth: navigate to the safe API-backed screen.
      if (typeof trackingNo === "string" && /^YS-\d{8}-[A-Z0-9]{5}$/.test(trackingNo)) {
        router.push(`/letters/${trackingNo}`);
      }
      refetchVisibleScreens();
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    };
    const tapped = Notifications.addNotificationResponseReceivedListener(handleResponse);
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) handleResponse(response);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      received.remove();
      tapped.remove();
    };
  }, [router, generation]);
  return null;
}

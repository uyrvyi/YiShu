import { useEffect, useRef, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
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
import { setPushStatus, type PushStatus } from "./status";

async function requestPushToken(projectId: string): Promise<{ data: string }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Notifications.getExpoPushTokenAsync({ projectId }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("push_token_timeout")), 20000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Enhancement only: denied permission / missing EAS project / offline never block Auth. */
export function PushRegistration(): null {
  const generation = useSyncExternalStore(subscribeSession, getSessionVersion, getSessionVersion);
  const router = useRouter();
  const lastResponse = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let registering = false;
    const report = (status: PushStatus) => {
      if (!cancelled && generation === getSessionVersion()) setPushStatus(status);
    };
    const register = async () => {
      if (!isAuthenticated()) {
        report("signed_out");
        return;
      }
      if (!["ios", "android"].includes(Platform.OS)) {
        report("unsupported");
        return;
      }
      if (Constants.executionEnvironment === "storeClient") {
        report("expo_go");
        return;
      }
      if (registering || cancelled) return;
      registering = true;
      report("registering");
      try {
        // Repair a failed offline logout before permission/token acquisition can return early.
        const retained = await readPushToken();
        if (retained && !cancelled)
          await registerDeviceForSession(
            retained,
            Platform.OS as "ios" | "android",
            generation
          ).catch(() => undefined);
        if (Platform.OS === "android")
          await Notifications.setNotificationChannelAsync("letters-v2", {
            name: "驿书",
            importance: Notifications.AndroidImportance.HIGH,
            sound: "default",
          });
        const permission = await Notifications.requestPermissionsAsync();
        if (!permission.granted || cancelled) {
          report("permission_denied");
          return;
        }
        const projectId: unknown =
          Constants.easConfig?.projectId ??
          Constants.expoConfig?.extra?.eas?.projectId ??
          process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
        if (typeof projectId !== "string" || !projectId) {
          report("project_missing");
          return;
        }
        let token: { data: string };
        try {
          token = await requestPushToken(projectId);
        } catch {
          report("token_failed");
          return;
        }
        if (!cancelled) {
          try {
            await registerDeviceForSession(
              token.data,
              Platform.OS as "ios" | "android",
              generation
            );
            report("ready");
          } catch {
            report("server_failed");
          }
        }
      } finally {
        registering = false;
      }
    };
    void register().catch(() => report("token_failed"));
    const tokenChange = Notifications.addPushTokenListener(() => {
      void register().catch(() => report("token_failed"));
    });
    const active = AppState.addEventListener("change", (state) => {
      if (state === "active") void register().catch(() => report("token_failed"));
    });
    return () => {
      cancelled = true;
      tokenChange.remove();
      active.remove();
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

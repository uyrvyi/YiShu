import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { AuthExpiredError } from "../api/authenticatedFetch";
import { createPoller } from "./poller";
import { getSessionVersion, subscribeSession } from "../api";

const refreshListeners = new Set<() => void>();
export function refetchVisibleScreens(): void {
  refreshListeners.forEach((fn) => fn());
}

export function usePolling<T>(load: () => Promise<T>, intervalMs: number) {
  const version = useSyncExternalStore(subscribeSession, getSessionVersion, getSessionVersion);
  const [snapshot, setSnapshot] = useState<{
    version: number;
    data: T | null;
    error: string | null;
  }>({ version, data: null, error: null });
  const focused = useRef(false);
  const router = useRouter();
  const activate = useRef<() => void>(() => {});
  const refreshNow = useRef<() => Promise<void>>(async () => {});
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      activate.current();
      return () => {
        focused.current = false;
        activate.current();
      };
    }, [])
  );
  useEffect(() => {
    const poller = createPoller({
      intervalMs,
      load,
      value: (value: T) => {
        if (version === getSessionVersion()) setSnapshot({ version, data: value, error: null });
      },
      error: (failure: unknown) => {
        if (version !== getSessionVersion()) return;
        setSnapshot({
          version,
          data: null,
          error: failure instanceof Error ? failure.message : "request_failed",
        });
        if (failure instanceof AuthExpiredError) router.replace("/");
      },
    });
    activate.current = () =>
      poller.setActive(focused.current && AppState.currentState === "active");
    activate.current();
    const subscription = AppState.addEventListener("change", (state) =>
      poller.setActive(focused.current && state === "active")
    );
    const refresh = () => {
      void poller.refresh();
    };
    refreshNow.current = poller.refresh;
    refreshListeners.add(refresh);
    return () => {
      poller.dispose();
      subscription.remove();
      refreshListeners.delete(refresh);
      activate.current = () => {};
      refreshNow.current = async () => {};
    };
  }, [load, intervalMs, router, version]);
  // Mask synchronously during render, before effect cleanup can run on an account change.
  const current = snapshot.version === version && version === getSessionVersion();
  return {
    data: current ? snapshot.data : null,
    error: current ? snapshot.error : null,
    refresh: () => refreshNow.current(),
  };
}

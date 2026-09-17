import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { AuthExpiredError } from "../api/authenticatedFetch";
import { createPoller } from "./poller";

const refreshListeners = new Set<() => void>();
export function refetchVisibleScreens(): void {
  refreshListeners.forEach((fn) => fn());
}

export function usePolling<T>(load: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const router = useRouter();
  const activate = useRef<() => void>(() => {});
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
        setData(value);
        setError(null);
      },
      error: (failure: unknown) => {
        setError(failure instanceof Error ? failure.message : "request_failed");
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
    refreshListeners.add(refresh);
    return () => {
      poller.dispose();
      subscription.remove();
      refreshListeners.delete(refresh);
      activate.current = () => {};
    };
  }, [load, intervalMs, router]);
  return { data, error };
}

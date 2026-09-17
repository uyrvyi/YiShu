import { AuthExpiredError } from "../api/authenticatedFetch";

export const DETAIL_POLL_MS = 5000;
export const HOME_POLL_MS = 30000;

/** No overlapping requests; stale background/unmount responses never reach the screen. */
export function createPoller<T>(options: {
  intervalMs: number;
  load: () => Promise<T>;
  value: (value: T) => void;
  error: (error: unknown) => void;
}) {
  let active = false,
    disposed = false,
    inFlight = false,
    pending = false,
    authFailed = false;
  let epoch = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const refresh = async (): Promise<void> => {
    if (!active || disposed || authFailed) return;
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    const started = epoch;
    try {
      const result = await options.load();
      if (active && !disposed && started === epoch) options.value(result);
    } catch (error) {
      // Only the epoch that is still current may stop polling: a failure raised by a
      // response from a previous focus/foreground must not kill the running timer.
      const current = active && !disposed && started === epoch;
      if (current && error instanceof AuthExpiredError) {
        authFailed = true;
        pending = false;
        stopTimer();
      }
      if (current) options.error(error);
    } finally {
      inFlight = false;
      if (pending) {
        pending = false;
        void refresh();
      }
    }
  };
  return {
    refresh,
    setActive(next: boolean) {
      if (disposed || next === active) return;
      active = next;
      epoch++;
      stopTimer();
      if (active && !authFailed) {
        void refresh();
        timer = setInterval(() => {
          void refresh();
        }, options.intervalMs);
      }
    },
    dispose() {
      disposed = true;
      active = false;
      pending = false;
      epoch++;
      stopTimer();
    },
  };
}

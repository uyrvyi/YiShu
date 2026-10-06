import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => {
  let cursor = 0;
  const slots: unknown[] = [];
  const cleanups = new Map<number, () => void>();
  const effects: (() => void)[] = [];
  const listeners = new Set<() => void>();
  const equal = (a: unknown[], b: unknown[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  const effect = (fn: () => unknown, deps: unknown[]) => {
    const index = cursor++;
    if (slots[index] && equal(slots[index] as unknown[], deps)) return;
    slots[index] = deps;
    effects.push(() => {
      cleanups.get(index)?.();
      const cleanup = fn();
      if (typeof cleanup === "function") cleanups.set(index, cleanup as () => void);
    });
  };
  return {
    generation: 1,
    replace: vi.fn(),
    start() {
      cursor = 0;
    },
    flush() {
      effects.splice(0).forEach((fn) => fn());
    },
    dispose() {
      cleanups.forEach((fn) => fn());
      cleanups.clear();
      slots.length = 0;
      effects.length = 0;
      listeners.clear();
    },
    state<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [
        slots[index] as T,
        (value: T) => {
          slots[index] = value;
        },
      ] as const;
    },
    ref<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    callback<T>(fn: T, deps: unknown[]) {
      const index = cursor++;
      const old = slots[index] as { fn: T; deps: unknown[] } | undefined;
      if (!old || !equal(old.deps, deps)) slots[index] = { fn, deps };
      return (slots[index] as { fn: T }).fn;
    },
    effect,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot(_subscribe: unknown, get: () => number) {
      return get();
    },
  };
});
vi.mock("react", () => ({
  useState: h.state,
  useRef: h.ref,
  useEffect: h.effect,
  useCallback: h.callback,
  useSyncExternalStore: h.snapshot,
}));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: vi.fn() }) },
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ replace: h.replace }),
  useFocusEffect: (fn: () => () => void) => h.effect(fn, [fn]),
}));
vi.mock("../api", () => ({ getSessionVersion: () => h.generation, subscribeSession: h.subscribe }));
import { usePolling } from "./usePolling";
import { AuthExpiredError } from "../api/authenticatedFetch";

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
describe("protected polling state across account changes", () => {
  beforeEach(() => {
    h.dispose();
    h.generation = 1;
    h.replace.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    h.dispose();
    vi.useRealTimers();
  });
  function render(load: () => Promise<string>) {
    h.start();
    return usePolling(load, 5000);
  }
  it("masks Alice's decrypted body immediately, before effect cleanup on a Bob render", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce("Alice plaintext")
      .mockRejectedValue(new Error("letter_not_found"));
    render(load);
    h.flush();
    await tick();
    expect(render(load).data).toBe("Alice plaintext");
    h.generation++;
    expect(render(load).data).toBeNull();
    h.flush();
    await tick();
    expect(render(load).data).toBeNull();
    expect(render(load).error).toBe("letter_not_found");
  });
  it("drops a late successful plaintext response from the previous account", async () => {
    let finish: (value: string) => void = () => {};
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValue("Bob body");
    render(load);
    h.flush();
    h.generation++;
    finish("Alice late body");
    await tick();
    expect(render(load).data).toBeNull();
    h.flush();
    await tick();
    expect(render(load).data).toBe("Bob body");
  });
  it("clears the body on authorization loss rather than retaining stale data", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce("Alice body")
      .mockRejectedValue(new AuthExpiredError());
    render(load);
    h.flush();
    await tick();
    expect(render(load).data).toBe("Alice body");
    await render(load).refresh();
    expect(render(load).data).toBeNull();
    expect(h.replace).toHaveBeenCalledWith("/");
  });
});

import { describe, expect, it, vi } from "vitest";
import { createAppearanceStore, parseAppearance, resolveAppearance } from "./appearanceStore";
import { C, DARK_COLORS } from "./theme";

describe("device appearance preference", () => {
  it("defaults to system and follows changes only in system mode", () => {
    for (const value of [null, "garbage", "system"]) expect(parseAppearance(value)).toBe("system");
    expect(resolveAppearance("system", "dark")).toBe("dark");
    expect(resolveAppearance("system", "light")).toBe("light");
    expect(resolveAppearance("system", "unspecified")).toBe("light");
    for (const mode of ["light", "dark"] as const)
      for (const system of ["light", "dark"]) expect(resolveAppearance(mode, system)).toBe(mode);
  });
  it.each(["light", "dark", "system", "invalid", null])("restores %s before showing content", async (value) => {
    const storage = { read: vi.fn(async () => value), write: vi.fn(async () => {}) };
    const store = createAppearanceStore(storage);
    expect(store.getSnapshot().ready).toBe(false);
    await store.initialize(); await store.initialize();
    expect(storage.read).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual({ preference: parseAppearance(value), ready: true, saving: false });
  });
  it("read failure uses system, save changes immediately and persists across a new store", async () => {
    let stored: string | null = null;
    const storage = { read: async () => stored, write: async (value: string) => { stored = value; } };
    const store = createAppearanceStore(storage);
    await store.initialize();
    const save = store.select("dark");
    expect(store.getSnapshot().preference).toBe("dark");
    await save;
    const restarted = createAppearanceStore(storage); await restarted.initialize();
    expect(restarted.getSnapshot().preference).toBe("dark");
    const failed = createAppearanceStore({ ...storage, read: async () => { throw Error("read"); } });
    await failed.initialize(); expect(failed.getSnapshot().preference).toBe("system");
  });
  it("rolls back failed saves and prevents overlapping writes", async () => {
    let reject!: (error: Error) => void;
    const write = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const store = createAppearanceStore({ read: async () => "light", write });
    const changed = vi.fn(); store.subscribe(changed); await store.initialize();
    const save = store.select("dark"); const failure = expect(save).rejects.toThrow("save");
    await store.select("system"); expect(write).toHaveBeenCalledOnce();
    reject(Error("save")); await failure;
    expect(store.getSnapshot()).toEqual({ preference: "light", ready: true, saving: false });
    expect(changed).toHaveBeenCalledTimes(3);
  });
  it("adapts paper while retaining solid-button foreground in both themes", () => {
    expect(C.paper).toBe("#FFFCF3");
    expect(C.paperInk).toBe(C.ink);
    expect(C.paperMuted).toBe(C.muted);
    expect(DARK_COLORS.paper).not.toBe(C.paper);
    expect(DARK_COLORS.paperInk).not.toBe(C.paperInk);
    expect(DARK_COLORS.paperRule).not.toBe(C.paperRule);
    expect(DARK_COLORS.onGreen).toBe(C.onGreen);
    expect(DARK_COLORS.greenSolid).toBe(C.greenSolid);
    expect(DARK_COLORS.green).not.toBe(DARK_COLORS.greenSolid);
  });
});

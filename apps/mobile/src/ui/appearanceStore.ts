export type AppearancePreference = "light" | "dark" | "system";
export const APPEARANCE_LABELS = { light: "浅色模式", dark: "深色模式", system: "跟随系统" };
export function parseAppearance(value: string | null): AppearancePreference {
  return value === "light" || value === "dark" ? value : "system";
}
export function resolveAppearance(preference: AppearancePreference, system: string | null) {
  return preference === "system" ? (system === "dark" ? "dark" : "light") : preference;
}

export function createAppearanceStore(storage: { read(): Promise<string | null>; write(value: string): Promise<void> }) {
  let snapshot = { preference: "system" as AppearancePreference, ready: false, saving: false };
  const listeners = new Set<() => void>();
  const update = (next: typeof snapshot) => { snapshot = next; listeners.forEach((listener) => listener()); };
  let initialization: Promise<void> | undefined;
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    initialize: () => initialization ??= (async () => {
      let preference: AppearancePreference = "system";
      try { preference = parseAppearance(await storage.read()); } catch { /* Keep the system default. */ }
      update({ preference, ready: true, saving: false });
    })(),
    async select(preference: AppearancePreference) {
      if (!snapshot.ready || snapshot.saving || snapshot.preference === preference) return;
      const previous = snapshot.preference;
      update({ preference, ready: true, saving: true });
      try {
        await storage.write(preference);
        update({ preference, ready: true, saving: false });
      } catch (error) {
        update({ preference: previous, ready: true, saving: false });
        throw error;
      }
    },
  };
}

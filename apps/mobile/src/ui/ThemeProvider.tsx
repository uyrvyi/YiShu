import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Alert, Appearance, useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";
import { SplashScreen } from "expo-router";
import { C, DARK_COLORS, type Colors } from "./theme";
import { createAppearanceStore, resolveAppearance } from "./appearanceStore";

const store = createAppearanceStore({
  read: () => SecureStore.getItemAsync("yishu.appearance"),
  write: (value) => SecureStore.setItemAsync("yishu.appearance", value),
});
void SplashScreen.preventAutoHideAsync().catch(() => undefined);
const ThemeContext = createContext({ colors: C as Colors, scheme: "light" as "light" | "dark",
  preference: "system" as "light" | "dark" | "system", saving: false, select: store.select });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const system = useColorScheme();
  const scheme = resolveAppearance(state.preference, system);
  useEffect(() => { void store.initialize(); }, []);
  useLayoutEffect(() => {
    if (state.ready) Appearance.setColorScheme(state.preference === "system" ? "unspecified" : state.preference);
  }, [state.preference, state.ready]);
  useEffect(() => { if (state.ready) void SplashScreen.hideAsync().catch(() => undefined); }, [state.ready]);
  const value = useMemo(() => ({ colors: scheme === "dark" ? DARK_COLORS : C, scheme,
    preference: state.preference, saving: state.saving,
    select: async (preference: typeof state.preference) => {
      try { await store.select(preference); } catch { Alert.alert("无法保存界面设置", "已恢复之前的选择，请重试。"); }
    },
  }), [scheme, state.preference, state.saving]);
  return <ThemeContext.Provider value={value}>{state.ready ? children : null}</ThemeContext.Provider>;
}

export function useAppTheme() { return useContext(ThemeContext); }
export function useThemedStyles<T>(factory: (colors: Colors) => T): T {
  const { colors } = useAppTheme();
  return useMemo(() => factory(colors), [factory, colors]);
}

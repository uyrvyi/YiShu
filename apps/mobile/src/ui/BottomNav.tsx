import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { PackageSearch, Plus, UserRound } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassSurface } from "./GlassSurface";
import { C, UI } from "./theme";
import { dragOffset, navGeometry, tabAtOffset, type NavTab } from "./navDrag";

export function useBottomNavContentInset() {
  return UI.bottomNavHeight + Math.max(12, useSafeAreaInsets().bottom) + 24;
}

export function BottomNav({ active }: { active: "letters" | "me" }) {
  const { bottom } = useSafeAreaInsets();
  const [width, setWidth] = useState(0);
  const [held, setHeld] = useState(false);
  const [hovered, setHovered] = useState<NavTab>(active);
  const translation = useRef(new Animated.Value(0)).current;
  const drag = useRef({ start: null as NavTab | null, moving: false, offset: 0 });
  const geometry = navGeometry(width);
  const current = useRef({ active, travel: geometry.travel });
  current.current = { active, travel: geometry.travel };
  useEffect(() => {
    translation.stopAnimation();
    translation.setValue(active === "me" ? geometry.travel : 0);
    setHovered(active);
    return () => translation.stopAnimation();
  }, [active, geometry.travel, translation]);
  const settle = useCallback(
    (target: NavTab, navigate: boolean) => {
      drag.current.moving = false;
      drag.current.start = null;
      setHeld(false);
      setHovered(target);
      Animated.spring(translation, {
        toValue: target === "me" ? current.current.travel : 0,
        damping: 24,
        stiffness: 280,
        mass: 0.8,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && navigate && target !== current.current.active)
          router.replace(target === "me" ? "/me" : "/letters");
      });
    },
    [translation]
  );
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) => {
          const horizontal =
            drag.current.start !== null &&
            Math.abs(gesture.dx) > 6 &&
            Math.abs(gesture.dx) > Math.abs(gesture.dy);
          if (horizontal) drag.current.moving = true;
          return horizontal;
        },
        onPanResponderGrant: () => {
          drag.current.moving = true;
          translation.stopAnimation();
          setHeld(true);
        },
        onPanResponderMove: (_event, gesture) => {
          const offset = dragOffset(
            drag.current.start ?? current.current.active,
            gesture.dx,
            current.current.travel
          );
          drag.current.offset = offset;
          translation.setValue(offset);
          setHovered(tabAtOffset(offset, current.current.travel));
        },
        onPanResponderRelease: () =>
          settle(tabAtOffset(drag.current.offset, current.current.travel), true),
        onPanResponderTerminate: () => settle(current.current.active, false),
        onPanResponderTerminationRequest: () => true,
      }),
    [settle, translation]
  );
  const items = [
    {
      key: "letters",
      label: "查件",
      icon: PackageSearch,
      onPress: () => router.replace("/letters"),
    },
    { key: "me", label: "我的", icon: UserRound, onPress: () => router.replace("/me") },
  ] as const;
  const tab = (item: (typeof items)[number]) => {
    const Icon = item.icon;
    const selected = hovered === item.key;
    return (
      <Pressable
        key={item.key}
        style={({ pressed }) => [styles.item, pressed && !held && styles.pressed]}
        accessibilityRole="tab"
        accessibilityLabel={item.label}
        accessibilityState={{ selected: active === item.key }}
        onPressIn={() => {
          drag.current.start = item.key;
          drag.current.offset = item.key === "me" ? geometry.travel : 0;
          setHeld(true);
        }}
        onPressOut={() => {
          if (!drag.current.moving) {
            drag.current.start = null;
            setHeld(false);
          }
        }}
        onPress={item.onPress}
      >
        <Icon size={22} strokeWidth={selected ? 2 : 1.7} color={selected ? C.green : C.muted} />
        <Text style={[styles.label, selected && styles.activeLabel]}>{item.label}</Text>
      </Pressable>
    );
  };
  return (
    <View pointerEvents="box-none" style={[styles.floating, { bottom: Math.max(12, bottom) }]}>
      <View
        style={styles.shadow}
        {...pan.panHandlers}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        <GlassSurface style={styles.nav}>
          {width > 96 ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.indicator,
                {
                  width: geometry.tabWidth,
                  transform: [{ translateX: translation }, { scale: held ? 1.035 : 1 }],
                },
              ]}
            >
              <GlassSurface appearance={held ? "clear" : "frosted"} style={styles.indicatorSurface}>
                {null}
              </GlassSurface>
            </Animated.View>
          ) : null}
          {tab(items[0])}
          <View style={styles.composeSlot}>
            <Pressable
              style={({ pressed }) => [styles.compose, pressed && styles.composePressed]}
              accessibilityRole="button"
              accessibilityLabel="写信"
              onPressIn={() => {
                drag.current.start = null;
              }}
              onPress={() => router.push("/letters/new")}
            >
              <Plus size={26} color={C.surface} strokeWidth={2} />
            </Pressable>
          </View>
          {tab(items[1])}
        </GlassSurface>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  floating: { position: "absolute", left: 20, right: 20, alignItems: "center" },
  shadow: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 36,
    shadowColor: "#202629",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 18,
    elevation: 8,
  },
  nav: {
    flexDirection: "row",
    borderRadius: 36,
    borderCurve: "continuous",
    height: UI.bottomNavHeight,
    alignItems: "center",
    paddingHorizontal: 8,
    gap: 4,
  },
  item: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    height: 56,
    borderRadius: 28,
    borderCurve: "continuous",
  },
  indicator: { position: "absolute", left: 8, top: 8, height: 56 },
  indicatorSurface: { width: "100%", height: "100%", borderRadius: 28, borderCurve: "continuous" },
  composeSlot: { width: 72, alignItems: "center", justifyContent: "center" },
  compose: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: C.green,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { backgroundColor: "rgba(25,116,92,0.16)" },
  composePressed: { backgroundColor: "#125B48", transform: [{ scale: 0.95 }] },
  label: { color: C.muted, fontSize: 11, fontWeight: "500" },
  activeLabel: { color: C.green },
});

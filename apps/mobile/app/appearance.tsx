import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Check, Moon, Smartphone, Sun } from "lucide-react-native";
import { ScreenHeader } from "../src/ui/controls";
import { useAppTheme, useThemedStyles } from "../src/ui/ThemeProvider";
import { APPEARANCE_LABELS, type AppearancePreference } from "../src/ui/appearanceStore";
import { UI, type Colors } from "../src/ui/theme";

const options = [{ value: "light", icon: Sun }, { value: "dark", icon: Moon },
  { value: "system", icon: Smartphone }] as const;

export default function AppearanceScreen() {
  const { colors, preference, saving, select } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  return <SafeAreaView style={styles.safe}>
    <View style={styles.content}>
      <ScreenHeader title="界面设置" backLabel="返回我的" onBack={() => router.back()} />
      <View style={styles.group} accessibilityRole="radiogroup">
        {options.map(({ value, icon: Icon }, index) => <View key={value}>
          {index > 0 ? <View style={styles.separator} /> : null}
          <Pressable accessibilityRole="radio" accessibilityLabel={APPEARANCE_LABELS[value]}
            accessibilityState={{ checked: preference === value, disabled: saving }} disabled={saving}
            onPress={() => void select(value as AppearancePreference)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <Icon size={20} color={colors.muted} />
            <Text style={styles.label}>{APPEARANCE_LABELS[value]}</Text>
            {preference === value ? <Check size={21} color={colors.green} /> : null}
          </Pressable>
        </View>)}
      </View>
    </View>
  </SafeAreaView>;
}

const createStyles = (C: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.canvas },
  content: { paddingHorizontal: UI.gutter, width: "100%", maxWidth: 680, alignSelf: "center" },
  group: { marginTop: 24, backgroundColor: C.surface, borderRadius: UI.radius, borderCurve: "continuous", overflow: "hidden" },
  row: { minHeight: 62, paddingHorizontal: 20, paddingVertical: 16, flexDirection: "row", alignItems: "center", gap: 14 },
  label: { flex: 1, fontSize: 16, color: C.ink },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginLeft: 54 },
  pressed: { opacity: UI.pressedOpacity },
});

import type { ReactNode } from "react";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { ArrowLeft, CircleAlert, Info, type LucideIcon } from "lucide-react-native";
import { C, UI } from "./theme";

export function FormInput({ style, onFocus, onBlur, editable, ...props }: TextInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      placeholderTextColor={C.muted}
      selectionColor={C.green}
      {...props}
      editable={editable}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      style={[
        styles.input,
        style,
        focused && styles.inputFocused,
        editable === false && styles.inputDisabled,
      ]}
    />
  );
}

export function ScreenHeader({
  title,
  backLabel,
  onBack,
  trailing,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
  trailing?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        onPress={onBack}
        style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
      >
        <ArrowLeft size={21} color={C.ink} strokeWidth={1.8} />
      </Pressable>
      <Text accessibilityRole="header" style={styles.headerTitle} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.headerButton}>{trailing}</View>
    </View>
  );
}

export function ActionButton({
  title,
  onPress,
  icon: Icon,
  disabled,
  quiet,
}: {
  title: string;
  onPress: () => void;
  icon?: LucideIcon;
  disabled?: boolean;
  quiet?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.action,
        quiet && styles.quiet,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {Icon ? <Icon size={18} color={quiet ? C.green : C.surface} /> : null}
      <Text style={[styles.actionText, quiet && styles.quietText]}>{title}</Text>
    </Pressable>
  );
}

export function Notice({
  tone = "error",
  children,
}: {
  tone?: "error" | "info";
  children: ReactNode;
}) {
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.notice, tone === "info" && styles.info]}
    >
      {tone === "info" ? (
        <Info size={18} color={C.green} />
      ) : (
        <CircleAlert size={18} color={C.error} />
      )}
      <Text style={[styles.noticeText, tone === "info" && styles.infoText]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: UI.controlHeight,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: UI.controlRadius,
    borderCurve: "continuous",
    backgroundColor: C.surface,
    paddingHorizontal: 15,
    paddingVertical: 12,
    color: C.ink,
    fontSize: 15,
  },
  inputFocused: { borderColor: C.green },
  inputDisabled: { backgroundColor: C.canvas, color: C.muted },
  header: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 8 },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, textAlign: "center", fontSize: 17, fontWeight: "600", color: C.ink },
  pressed: { opacity: UI.pressedOpacity },
  action: {
    minHeight: UI.controlHeight,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: UI.controlRadius,
    borderCurve: "continuous",
    backgroundColor: C.green,
    shadowColor: C.green,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 2,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  actionText: {
    color: C.surface,
    fontWeight: "600",
    fontSize: 15,
    lineHeight: 22,
    flexShrink: 1,
    textAlign: "center",
  },
  quiet: { backgroundColor: C.greenSoft },
  quietText: { color: C.green },
  disabled: { opacity: 0.45 },
  notice: {
    padding: 14,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderRadius: UI.radius,
    backgroundColor: C.errorSoft,
  },
  noticeText: { color: C.error, fontSize: 14, lineHeight: 21, flex: 1 },
  info: { backgroundColor: C.greenSoft },
  infoText: { color: C.ink },
});

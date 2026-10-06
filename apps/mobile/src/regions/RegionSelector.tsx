import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Check, ChevronDown, LocateFixed, X } from "lucide-react-native";
import { FormInput, KeyboardFrame } from "../ui/controls";
import { C, UI } from "../ui/theme";
import {
  changeRegion,
  citiesFor,
  districtsFor,
  provinces,
  type Region,
  type RegionNode,
} from "./regions";
import { locateRegion } from "./locate";

const levels: Array<keyof Region> = ["province", "city", "district"];
const labels = { province: "省", city: "市", district: "区县" };

export function RegionSelector({
  value,
  onChange,
  autoLocate = false,
  disabled = false,
}: {
  value: Region;
  onChange: (region: Region) => void;
  autoLocate?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState<keyof Region | null>(null);
  const [query, setQuery] = useState("");
  const [locating, setLocating] = useState(false);
  const generation = useRef(0);
  const loading = useRef(false);
  const latest = useRef({ value, onChange, disabled });
  latest.current = { value, onChange, disabled };
  const initiallyEmpty = useRef(!value.province);

  async function locate(showResult = true) {
    if (loading.current || disabled) return;
    loading.current = true;
    setLocating(true);
    const version = generation.current;
    try {
      const result = await locateRegion();
      if (version !== generation.current || latest.current.disabled) return;
      if ("region" in result) {
        latest.current.onChange(result.region);
        if (result.partial || showResult)
          Alert.alert("定位完成", result.partial ? "已定位，请补选区县" : "已预选所在地区");
      } else
        Alert.alert(
          "定位未完成",
          result.error === "denied" ? "未授权定位，请手动选择" : "定位暂不可用，请手动选择"
        );
    } catch {
      if (version === generation.current) Alert.alert("定位未完成", "定位暂不可用，请手动选择");
    } finally {
      loading.current = false;
      if (version === generation.current) setLocating(false);
    }
  }

  useEffect(() => {
    if (autoLocate && initiallyEmpty.current) void locate(false);
    return () => {
      generation.current++;
    };
  }, [autoLocate]);

  function select(node: RegionNode) {
    if (!open || disabled) return;
    generation.current++;
    setLocating(false);
    onChange(changeRegion(value, open, node.name));
    setQuery("");
    setOpen(open === "province" ? "city" : open === "city" ? "district" : null);
  }
  const options = (
    open === "province"
      ? provinces
      : open === "city"
        ? citiesFor(value.province)
        : districtsFor(value)
  ).filter((node) => node.name.includes(query.trim()));

  return (
    <View>
      <View style={styles.fields}>
        {levels.map((level) => (
          <Pressable
            key={level}
            style={styles.field}
            accessibilityRole="button"
            accessibilityLabel={`选择${labels[level]}`}
            disabled={
              disabled ||
              (level === "city" && !value.province) ||
              (level === "district" && !value.city)
            }
            onPress={() => {
              generation.current++;
              setLocating(false);
              setQuery("");
              setOpen(level);
            }}
          >
            <Text style={styles.label}>{labels[level]}</Text>
            <Text style={[styles.value, !value[level] && styles.placeholder]}>
              {value[level] || "请选择"}
            </Text>
            <ChevronDown size={16} color={C.muted} />
          </Pressable>
        ))}
      </View>
      <View style={styles.locationRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="定位所在地区"
          style={styles.locate}
          disabled={locating || disabled}
          onPress={() => void locate()}
        >
          {locating ? (
            <ActivityIndicator color={C.green} size="small" />
          ) : (
            <LocateFixed color={C.green} size={18} />
          )}
          <Text style={styles.locationText}>{locating ? "定位中" : "当前位置"}</Text>
        </Pressable>
      </View>
      <Modal
        visible={open !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(null)}
      >
        <KeyboardFrame style={styles.backdrop} keyboardVerticalOffset={0}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <View style={styles.sheetHeader}>
              <Text style={styles.title}>选择{open ? labels[open] : "地区"}</Text>
              <Pressable
                style={styles.close}
                accessibilityRole="button"
                accessibilityLabel="关闭地区选择"
                onPress={() => setOpen(null)}
              >
                <X size={22} color={C.ink} />
              </Pressable>
            </View>
            <FormInput
              value={query}
              onChangeText={setQuery}
              placeholder="搜索地区"
              accessibilityLabel="搜索地区"
              autoCorrect={false}
            />
            <FlatList
              data={options}
              keyExtractor={(item) => item.code}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              style={styles.list}
              ListEmptyComponent={<Text style={styles.empty}>未找到该地区</Text>}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.option}
                  accessibilityRole="button"
                  accessibilityState={{ selected: !!open && value[open] === item.name }}
                  onPress={() => select(item)}
                >
                  <Text style={styles.optionText}>{item.name}</Text>
                  {open && value[open] === item.name ? <Check size={20} color={C.green} /> : null}
                </Pressable>
              )}
            />
          </View>
        </KeyboardFrame>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  fields: {
    borderRadius: UI.controlRadius,
    borderWidth: 1,
    borderColor: C.line,
    overflow: "hidden",
  },
  field: {
    flexDirection: "row",
    minHeight: 56,
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  label: { fontSize: 14, color: C.muted, width: 36 },
  value: { fontSize: 14, color: C.ink, flex: 1, textAlign: "right", lineHeight: 21 },
  placeholder: { color: C.muted },
  locationRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  locate: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 },
  locationText: { color: C.green, fontSize: 13 },
  notice: { fontSize: 12, color: C.muted, flex: 1, lineHeight: 18 },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "#20262970" },
  sheet: {
    maxHeight: "78%",
    minHeight: "55%",
    padding: 20,
    paddingBottom: 36,
    borderTopLeftRadius: UI.radius,
    borderTopRightRadius: UI.radius,
    backgroundColor: C.surface,
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  title: { fontSize: 19, fontWeight: "600", color: C.ink },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  list: { flexGrow: 1, flexShrink: 1, minHeight: 0, marginTop: 10 },
  option: {
    flexDirection: "row",
    minHeight: 56,
    paddingVertical: 14,
    alignItems: "center",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  optionText: { flex: 1, color: C.ink, fontSize: 16, lineHeight: 24 },
  empty: { color: C.muted, marginVertical: 24, textAlign: "center" },
});

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Redirect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowRight, LogIn, Mail } from "lucide-react-native";
import {
  isAuthenticated,
  loginSession,
  registerSession,
  restoreSession,
  subscribeSession,
} from "../src/api";
import { ActionButton, FormInput, KeyboardFrame } from "../src/ui/controls";
import { problemMessage } from "../src/ui/presentation";
import { C, UI } from "../src/ui/theme";
import { RegionSelector } from "../src/regions/RegionSelector";
import { isRegionServiceUnavailable, REGION_SERVICE_UNAVAILABLE_MESSAGE } from "@yishu/shared";

function authMessage(error: unknown): string {
  if (error instanceof Error) {
    if (/login_failed:401|login_failed:404/.test(error.message)) return "账号或密码不正确";
    if (/register_failed:409/.test(error.message)) return "账号已被使用";
    if (/^(login|register)_failed:429$/.test(error.message)) return "尝试过于频繁，请稍后再试";
    if (/failed:400/.test(error.message)) return "请检查账号、密码和地区信息";
  }
  return problemMessage(error);
}

export default function HomeScreen() {
  const authed = useSyncExternalStore(subscribeSession, isAuthenticated, isAuthenticated);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [province, setProvince] = useState("");
  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("");
  const [error, setError] = useState<string | null>(null);
  function showError(message: string) {
    setError(message);
    Alert.alert("未能完成", message);
  }

  useEffect(() => {
    let mounted = true;
    void restoreSession()
      .catch((failure: unknown) => {
        if (mounted) showError(authMessage(failure));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function submit() {
    if (busy) return;
    if (mode === "register" && isRegionServiceUnavailable({ province, city, district })) {
      showError(REGION_SERVICE_UNAVAILABLE_MESSAGE);
      return;
    }
    const normalized = account.trim();
    if (!/^[a-zA-Z0-9_]{4,24}$/.test(normalized) || /^\d{8}$/.test(normalized)) {
      showError("账号需为 4–24 位字母、数字或下划线，不能是 8 位纯数字");
      return;
    }
    if (password.length < 8 || password.length > 72) {
      showError("密码需为 8–72 位");
      return;
    }
    if (
      mode === "register" &&
      (!nickname.trim() || !province.trim() || !city.trim() || !district.trim())
    ) {
      showError("请填写昵称和所在省、市、区县");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        await loginSession(normalized, password);
      } else {
        await registerSession({
          account: normalized,
          password,
          nickname: nickname.trim(),
          province: province.trim(),
          city: city.trim(),
          district: district.trim(),
        });
      }
    } catch (failure) {
      showError(authMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function retryRestore() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await restoreSession();
    } catch (failure) {
      showError(authMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  if (authed) return <Redirect href="/letters" />;
  if (loading) {
    return (
      <SafeAreaView style={styles.loading}>
        <ActivityIndicator color={C.green} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardFrame nativeInsets>
        <ScrollView
          automaticallyAdjustKeyboardInsets
          style={styles.keyboard}
          contentContainerStyle={styles.page}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <View style={styles.brand}>
            <View style={styles.brandMark}>
              <Mail size={27} strokeWidth={1.5} color={C.green} />
            </View>
            <Text accessibilityRole="header" style={styles.wordmark}>
              驿书
            </Text>
            <Text style={styles.brandLine}>有一句话，正在向你走来。</Text>
          </View>
          <View style={styles.tabs}>
            {(["login", "register"] as const).map((next) => (
              <Pressable
                key={next}
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === next }}
                disabled={busy}
                onPress={() => {
                  setMode(next);
                  setError(null);
                }}
                style={({ pressed }) => [
                  styles.tab,
                  mode === next && styles.tabActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.tabText, mode === next && styles.tabTextActive]}>
                  {next === "login" ? "登录" : "注册"}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>账号</Text>
          <FormInput
            style={styles.input}
            placeholder="字母、数字或下划线"
            placeholderTextColor={C.muted}
            value={account}
            onChangeText={setAccount}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="账号"
          />
          <Text style={styles.label}>密码</Text>
          <FormInput
            style={styles.input}
            placeholder="至少 8 位"
            placeholderTextColor={C.muted}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            accessibilityLabel="密码"
          />
          {mode === "register" ? (
            <>
              <Text style={styles.label}>昵称</Text>
              <FormInput
                style={styles.input}
                placeholder="收件人看到的名字"
                placeholderTextColor={C.muted}
                value={nickname}
                onChangeText={setNickname}
                accessibilityLabel="昵称"
              />
              <Text style={styles.label}>所在地区</Text>
              <RegionSelector
                value={{ province, city, district }}
                autoLocate
                disabled={busy}
                onChange={(region) => {
                  setProvince(region.province);
                  setCity(region.city);
                  setDistrict(region.district);
                }}
              />
            </>
          ) : null}
          {error?.includes("网络") || error?.includes("服务暂时") ? (
            <View style={styles.retry}>
              <ActionButton
                title="重试连接"
                quiet
                onPress={() => void retryRestore()}
                disabled={busy}
              />
            </View>
          ) : null}
          <View style={styles.submit}>
            <ActionButton
              title={busy ? "请稍候…" : mode === "login" ? "进入驿书" : "创建账号"}
              onPress={() => void submit()}
              icon={mode === "login" ? LogIn : ArrowRight}
              disabled={busy}
            />
          </View>
        </ScrollView>
      </KeyboardFrame>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.surface },
  keyboard: { flex: 1 },
  loading: { flex: 1, backgroundColor: C.surface, justifyContent: "center" },
  page: {
    flexGrow: 1,
    width: "100%",
    maxWidth: 480,
    alignSelf: "center",
    paddingHorizontal: UI.gutter,
    paddingBottom: 34,
  },
  brand: { paddingTop: 40, paddingBottom: 36 },
  brandMark: {
    width: 54,
    height: 54,
    backgroundColor: C.greenSoft,
    borderRadius: UI.radius,
    marginBottom: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  wordmark: { color: C.ink, fontSize: 34, fontWeight: "600" },
  brandLine: { color: C.muted, fontSize: 14, lineHeight: 22, marginTop: 10 },
  tabs: {
    flexDirection: "row",
    backgroundColor: C.canvas,
    padding: 4,
    gap: 4,
    borderRadius: UI.radius,
    marginBottom: 28,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    paddingVertical: 10,
    borderRadius: UI.segmentRadius,
  },
  tabActive: { backgroundColor: C.surface },
  tabText: { color: C.muted, fontSize: 14, fontWeight: "500" },
  tabTextActive: { color: C.ink, fontWeight: "600" },
  pressed: { opacity: UI.pressedOpacity },
  label: { color: C.ink, fontSize: 13, fontWeight: "500", marginBottom: 9 },
  input: {
    marginBottom: 18,
  },
  regionRow: { flexDirection: "row", gap: 10 },
  regionInput: { flex: 1, minWidth: 0 },
  submit: { marginTop: 14 },
  retry: { marginTop: 10 },
});

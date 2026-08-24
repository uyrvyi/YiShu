import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Link } from "expo-router";

/**
 * 驿书首页：最小真实认证入口。
 * - 启动时 restoreSession（读取 SecureStore refresh token → /auth/refresh）。
 * - 未认证 → 显示 Login / Register 最小表单。
 * - 认证成功 → 可进入信件列表。
 * 不要求产品级 UI，仅建立可运行的真实 Session。
 */
export default function HomeScreen() {
  const [loading, setLoading] = useState(true);
  const [authed, setAuthed] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [province, setProvince] = useState("");
  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function init() {
      try {
        const { restoreSession } = await import("../src/api/index");
        setAuthed(await restoreSession());
      } finally {
        setLoading(false);
      }
    }
    void init();
  }, []);

  async function submit() {
    try {
      setError(null);
      const { loginSession, registerSession } = await import("../src/api/index");
      if (mode === "login") {
        await loginSession(account.trim(), password);
      } else {
        // 注册需提供真实区域（省/市/区县），禁止伪造
        if (!province.trim() || !city.trim() || !district.trim()) {
          setError("请填写省、市、区县");
          return;
        }
        await registerSession({
          account: account.trim(),
          password,
          nickname: nickname.trim() || "用户",
          province: province.trim(),
          city: city.trim(),
          district: district.trim(),
        });
      }
      setAuthed(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (loading) {
    return <Text style={styles.center}>加载中...</Text>;
  }

  if (authed) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>驿书</Text>
        <Text style={styles.subtitle}>已登录</Text>
        <Link href="/letters" style={styles.link}>
          <Text>进入我的信件</Text>
        </Link>
        <Pressable
          style={styles.button}
          onPress={async () => {
            const { logoutSession } = await import("../src/api/index");
            try {
              await logoutSession();
            } finally {
              // logout 即使抛错也必须退出登录态（避免 UI 残留"已登录"）
              setAuthed(false);
            }
          }}
        >
          <Text style={styles.buttonText}>退出</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>驿书</Text>
      <Text style={styles.subtitle}>{mode === "login" ? "登录" : "注册"}</Text>
      <TextInput
        style={styles.input}
        placeholder="账号"
        value={account}
        onChangeText={setAccount}
      />
      <TextInput
        style={styles.input}
        placeholder="密码"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />
      {mode === "register" ? (
        <>
          <TextInput
            style={styles.input}
            placeholder="昵称"
            value={nickname}
            onChangeText={setNickname}
          />
          <TextInput
            style={styles.input}
            placeholder="省（如 上海市）"
            value={province}
            onChangeText={setProvince}
          />
          <TextInput
            style={styles.input}
            placeholder="市（如 上海市）"
            value={city}
            onChangeText={setCity}
          />
          <TextInput
            style={styles.input}
            placeholder="区县（如 徐汇区）"
            value={district}
            onChangeText={setDistrict}
          />
        </>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.button} onPress={() => void submit()}>
        <Text style={styles.buttonText}>{mode === "login" ? "登录" : "注册"}</Text>
      </Pressable>
      <Pressable onPress={() => setMode(mode === "login" ? "register" : "login")}>
        <Text style={styles.linkText}>
          {mode === "login" ? "没有账号？注册" : "已有账号？登录"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", padding: 24, justifyContent: "center" },
  center: { flex: 1, textAlign: "center", textAlignVertical: "center" },
  title: { fontSize: 28, fontWeight: "700", textAlign: "center", marginBottom: 8 },
  subtitle: { fontSize: 16, color: "#666", textAlign: "center", marginBottom: 24 },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  button: {
    backgroundColor: "#1a73e8",
    padding: 14,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 8,
  },
  buttonText: { color: "#fff", fontWeight: "600" },
  link: { marginTop: 16, textAlign: "center", color: "#1a73e8" },
  linkText: { marginTop: 16, textAlign: "center", color: "#1a73e8" },
  error: { color: "red", marginBottom: 8, textAlign: "center" },
});

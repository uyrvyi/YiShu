import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  Alert,
  AppState,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import {
  Bell,
  BellRing,
  ChevronRight,
  Layers,
  LogOut,
  MapPin,
  UserRound,
} from "lucide-react-native";
import { getApi, logoutSession } from "../src/api";
import { AuthExpiredError } from "../src/api/authenticatedFetch";
import { usePolling } from "../src/refresh/usePolling";
import { BottomNav, useBottomNavContentInset } from "../src/ui/BottomNav";
import { Notice } from "../src/ui/controls";
import { C, UI } from "../src/ui/theme";
import { getGlassDiagnostics } from "../src/ui/GlassSurface";
import { PrivateAvatar } from "../src/media/PrivateImage";
import {
  getPushStatus,
  PUSH_STATUS_DETAILS,
  PUSH_STATUS_LABELS,
  subscribePushStatus,
} from "../src/push/status";

export default function MeScreen() {
  const bottomInset = useBottomNavContentInset();
  const load = useCallback(async () => {
    try {
      return await getApi().getCurrentUser();
    } catch (failure) {
      if (failure instanceof AuthExpiredError) router.replace("/");
      throw failure;
    }
  }, []);
  const { data: user, error, refresh } = usePolling(load, 60_000);
  const [permission, setPermission] = useState<string>("检查中");
  const [leaving, setLeaving] = useState(false);
  const [schedulingTest, setSchedulingTest] = useState(false);
  const pushStatus = useSyncExternalStore(subscribePushStatus, getPushStatus, getPushStatus);

  useEffect(() => {
    const updatePermission = () => {
      void Notifications.getPermissionsAsync()
        .then((result) => setPermission(result.granted ? "已允许" : "未允许"))
        .catch(() => setPermission("查看系统设置"));
    };
    updatePermission();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") updatePermission();
    });
    return () => subscription.remove();
  }, []);

  function confirmLogout() {
    Alert.alert("退出登录？", "下次可使用账号和密码重新登录。", [
      { text: "取消", style: "cancel" },
      {
        text: "退出登录",
        style: "destructive",
        onPress: () => {
          if (leaving) return;
          setLeaving(true);
          void logoutSession()
            .catch(() => undefined)
            .finally(() => router.replace("/"));
        },
      },
    ]);
  }

  async function testNotification() {
    if (schedulingTest) return;
    setSchedulingTest(true);
    try {
      let result = await Notifications.getPermissionsAsync();
      if (!result.granted) result = await Notifications.requestPermissionsAsync();
      setPermission(result.granted ? "已允许" : "未允许");
      if (!result.granted) {
        Alert.alert("通知权限未开启", "请在系统设置中允许 Expo Go 发送通知。", [
          { text: "取消", style: "cancel" },
          { text: "打开设置", onPress: () => void Linking.openSettings() },
        ]);
        return;
      }
      await Notifications.scheduleNotificationAsync({
        content: { title: "驿书测试通知", body: "这是一条本地通知测试。" },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 10 },
      });
      Alert.alert("测试通知已安排", "约 10 秒后送达，可切到后台查看。", [{ text: "知道了" }]);
    } catch {
      Alert.alert("无法安排测试通知", "请检查通知权限后重试。");
    } finally {
      setSchedulingTest(false);
    }
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safe}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}>
        <Text accessibilityRole="header" style={styles.title}>
          我的
        </Text>
        {error ? (
          <Pressable onPress={() => void refresh()} accessibilityRole="button">
            <Notice>账号信息暂时无法更新，点此重试</Notice>
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.identity, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="修改头像和昵称"
          disabled={!user}
          onPress={() => router.push("/profile")}
        >
          <View style={[styles.avatar, { overflow: "hidden" }]}>
            {user?.avatarUrl ? (
              <PrivateAvatar url={user.avatarUrl} />
            ) : user ? (
              <Text style={styles.avatarText}>{Array.from(user.nickname)[0] ?? "我"}</Text>
            ) : (
              <UserRound size={24} color={C.blue} />
            )}
          </View>
          <View style={styles.identityText}>
            <Text style={styles.nickname}>{user?.nickname ?? "正在加载"}</Text>
            <Text style={styles.account}>{user ? `@${user.account}` : ""}</Text>
          </View>
          <ChevronRight size={20} color={C.muted} />
        </Pressable>

        <Text accessibilityRole="header" style={styles.sectionTitle}>
          账号信息
        </Text>
        <View style={styles.group} testID="account-settings-group">
          <View style={styles.row}>
            <UserRound size={19} color={C.muted} />
            <Text style={styles.rowLabel}>用户编号</Text>
            <Text selectable style={styles.rowValue}>
              {user?.uid ?? "—"}
            </Text>
          </View>
          <View style={styles.separator} />
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="修改所在地区"
            disabled={!user}
            onPress={() => router.push({ pathname: "/profile", params: { section: "region" } })}
          >
            <MapPin size={19} color={C.muted} />
            <Text style={styles.rowLabel}>所在地区</Text>
            <Text style={styles.rowValue}>
              {user ? `${user.region.province} ${user.region.city} ${user.region.district}` : "—"}
            </Text>
            <ChevronRight size={17} color={C.muted} />
          </Pressable>
        </View>

        <Text accessibilityRole="header" style={styles.sectionTitle}>
          设置
        </Text>
        <View style={styles.group} testID="preferences-settings-group">
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="打开系统通知设置"
            onPress={() =>
              void Linking.openSettings().catch(() =>
                Alert.alert("无法打开系统设置", "请在设备设置中找到驿书并管理通知权限。")
              )
            }
          >
            <Bell size={19} color={C.muted} />
            <Text style={styles.rowLabel}>通知权限</Text>
            <Text style={styles.rowValue}>{permission}</Text>
            <ChevronRight size={17} color={C.muted} />
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            style={styles.row}
            accessibilityRole="button"
            accessibilityLabel="查看远程通知状态"
            onPress={() => Alert.alert("远程通知", PUSH_STATUS_DETAILS[pushStatus])}
          >
            <BellRing size={19} color={C.muted} />
            <Text style={styles.rowLabel}>远程通知</Text>
            <Text style={styles.rowValue}>{PUSH_STATUS_LABELS[pushStatus]}</Text>
            <ChevronRight size={17} color={C.muted} />
          </Pressable>
          {__DEV__ ? (
            <>
              <View style={styles.separator} />
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel="测试本地通知"
                disabled={schedulingTest}
                onPress={() => void testNotification()}
              >
                <BellRing size={19} color={C.muted} />
                <Text style={styles.rowLabel}>测试本地通知</Text>
                {schedulingTest ? <Text style={styles.rowValue}>安排中</Text> : null}
                <ChevronRight size={17} color={C.muted} />
              </Pressable>
              <View style={styles.separator} />
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel="检查底栏材质"
                onPress={() =>
                  void getGlassDiagnostics()
                    .then((result) => {
                      Alert.alert("底栏材质诊断", result);
                    })
                    .catch(() => Alert.alert("诊断失败", "无法读取设备的透明度设置，请重试。"))
                }
              >
                <Layers size={19} color={C.blue} />
                <Text style={styles.rowLabel}>底栏材质诊断</Text>
                <ChevronRight size={17} color={C.muted} />
              </Pressable>
            </>
          ) : null}
        </View>

        <Pressable
          style={({ pressed }) => [styles.logout, (pressed || leaving) && styles.pressed]}
          accessibilityRole="button"
          disabled={leaving}
          onPress={confirmLogout}
        >
          <LogOut size={19} color={C.error} />
          <Text style={styles.logoutText}>退出登录</Text>
        </Pressable>
      </ScrollView>
      <BottomNav active="me" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.canvas },
  content: { width: "100%", maxWidth: 680, alignSelf: "center", paddingBottom: 32 },
  title: {
    color: C.ink,
    fontSize: 28,
    fontWeight: "700",
    marginHorizontal: UI.gutter,
    marginTop: 24,
  },
  identity: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
    paddingHorizontal: UI.gutter,
    paddingVertical: 32,
    marginTop: 8,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: C.blueSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: C.blue, fontSize: 26, fontWeight: "500" },
  identityText: { flex: 1 },
  nickname: { color: C.ink, fontSize: 22, fontWeight: "600", lineHeight: 30 },
  account: { color: C.muted, fontSize: 14, marginTop: 6, lineHeight: 22 },
  sectionTitle: {
    color: C.muted,
    fontSize: 12,
    fontWeight: "500",
    marginHorizontal: UI.gutter,
    marginTop: 24,
    marginBottom: 12,
  },
  group: {
    marginHorizontal: UI.gutter,
    borderRadius: UI.radius,
    borderCurve: "continuous",
    overflow: "hidden",
    backgroundColor: C.surface,
    shadowColor: C.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.035,
    shadowRadius: 12,
  },
  row: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 20,
    gap: 12,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: C.line,
    marginLeft: 51,
    marginRight: 20,
  },
  rowLabel: { color: C.ink, fontSize: 14, flex: 1, lineHeight: 22 },
  rowValue: {
    color: C.muted,
    fontSize: 13,
    lineHeight: 21,
    textAlign: "right",
    flexShrink: 1,
    maxWidth: "55%",
  },
  logout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 11,
    padding: 20,
    marginHorizontal: UI.gutter,
    marginTop: 24,
    minHeight: 64,
    borderRadius: 32,
    borderCurve: "continuous",
    backgroundColor: C.surface,
    shadowColor: C.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.045,
    shadowRadius: 12,
    elevation: 2,
  },
  logoutText: { color: C.error, fontSize: 14, fontWeight: "500" },
  pressed: { backgroundColor: C.blueSoft },
});

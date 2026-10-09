import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Check, ChevronRight, UserRound } from "lucide-react-native";
import { getApi } from "../src/api";
import { AuthExpiredError } from "../src/api/authenticatedFetch";
import type { AuthUser } from "../src/auth/authService";
import { RegionSelector } from "../src/regions/RegionSelector";
import { ActionButton, FormInput, KeyboardFrame, ScreenHeader } from "../src/ui/controls";
import { problemMessage } from "../src/ui/presentation";
import { type Colors, UI } from "../src/ui/theme";
import { useAppTheme, useThemedStyles } from "../src/ui/ThemeProvider";
import { refetchVisibleScreens } from "../src/refresh/usePolling";
import type { UploadImageInput } from "../src/api/letterApi";
import { PrivateAvatar } from "../src/media/PrivateImage";
import { pickImages } from "../src/media/picker";
import { prepareAvatar, type CropImage } from "../src/media/avatarCrop";
import { AvatarCropper } from "../src/media/AvatarCropper";

export default function ProfileScreen() {
  const { colors: C } = useAppTheme();
  const styles = useThemedStyles(createStyles);

  const { section } = useLocalSearchParams<{ section?: string }>();
  const editingRegion = section === "region";
  const [original, setOriginal] = useState<AuthUser | null>(null);
  const [nickname, setNickname] = useState("");
  const [region, setRegion] = useState({ province: "", city: "", district: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const saving = useRef(false);
  const picking = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const [crop, setCrop] = useState<CropImage | null>(null);
  useEffect(() => {
    let active = true;
    setError(null);
    void getApi()
      .getCurrentUser()
      .then((user) => {
        if (!active) return;
        setOriginal(user);
        setNickname(user.nickname);
        setRegion(user.region);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (failure instanceof AuthExpiredError) router.replace("/");
        else {
          setError(problemMessage(failure));
          Alert.alert("资料未加载", problemMessage(failure));
        }
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  async function chooseImage(source: "album" | "files") {
    if (picking.current || saving.current) return;
    picking.current = true;
    setPreparing(true);
    try {
      const [image] = await pickImages(source, 1, { purpose: "avatar" });
      if (image) setCrop(await prepareAvatar(image));
    } catch (failure) {
      Alert.alert("图片无法打开", problemMessage(failure));
    } finally {
      picking.current = false;
      setPreparing(false);
    }
  }

  function chooseAvatar() {
    Alert.alert("修改头像", undefined, [
      { text: "相册", onPress: () => void chooseImage("album") },
      { text: "图片文件", onPress: () => void chooseImage("files") },
      { text: "取消", style: "cancel" },
    ]);
  }

  async function uploadAvatar(input: UploadImageInput) {
    try {
      const image = await getApi().uploadImage(input, true);
      setOriginal((user) => (user ? { ...user, avatarUrl: image.url } : user));
      refetchVisibleScreens();
    } catch (failure) {
      if (failure instanceof AuthExpiredError) {
        setCrop(null);
        router.replace("/");
      }
      throw failure;
    }
  }

  async function save() {
    if (saving.current || picking.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await getApi().updateProfile(editingRegion ? { region } : { nickname: nickname.trim() });
      refetchVisibleScreens();
      Alert.alert("已更新", editingRegion ? "所在地区已更新。" : "昵称已更新。", [
        {
          text: "完成",
          onPress: () => (router.canGoBack() ? router.back() : router.replace("/me")),
        },
      ]);
    } catch (failure) {
      if (failure instanceof AuthExpiredError) router.replace("/");
      else Alert.alert("未能保存", problemMessage(failure));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  function confirmSave() {
    const changed =
      editingRegion &&
      original &&
      (original.region.province !== region.province ||
        original.region.city !== region.city ||
        original.region.district !== region.district);
    if (changed)
      Alert.alert(
        "修改收信地区？",
        "在途信件会在下一驿站改道；正在末端派送的信件会从最后一个驿站重新出发。已送达的信件不变。",
        [
          { text: "取消", style: "cancel" },
          { text: "保存", onPress: () => void save() },
        ]
      );
    else void save();
  }
  const valid =
    !!original &&
    (editingRegion
      ? !!region.province && !!region.city && !!region.district
      : Array.from(nickname.trim()).length > 0 && Array.from(nickname.trim()).length <= 20);

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardFrame nativeInsets>
        <ScrollView
          automaticallyAdjustKeyboardInsets
          style={styles.flex}
          contentContainerStyle={styles.page}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <ScreenHeader
            title={editingRegion ? "所在地区" : "头像与昵称"}
            backLabel="返回我的"
            onBack={() => (router.canGoBack() ? router.back() : router.replace("/me"))}
          />
          {!original && !error ? (
            <ActivityIndicator style={styles.loading} color={C.green} />
          ) : null}
          {original ? (
            <>
              {editingRegion ? (
                <>
                  <Text style={styles.label}>所在地区</Text>
                  <RegionSelector value={region} onChange={setRegion} disabled={busy} />
                </>
              ) : (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="修改头像"
                    disabled={busy || preparing}
                    onPress={chooseAvatar}
                    style={({ pressed }) => [
                      styles.avatarRow,
                      pressed && { opacity: UI.pressedOpacity },
                    ]}
                  >
                    <Text style={styles.avatarLabel}>头像</Text>
                    <View style={styles.avatar}>
                      {original.avatarUrl ? (
                        <PrivateAvatar url={original.avatarUrl} />
                      ) : (
                        <UserRound color={C.blue} size={32} />
                      )}
                    </View>
                    {preparing ? (
                      <ActivityIndicator color={C.green} />
                    ) : (
                      <ChevronRight size={18} color={C.muted} />
                    )}
                  </Pressable>
                  <Text style={styles.label}>昵称</Text>
                  <FormInput
                    value={nickname}
                    onChangeText={setNickname}
                    accessibilityLabel="昵称"
                    editable={!busy && !preparing}
                  />
                </>
              )}
              <View style={styles.save}>
                <ActionButton
                  title={busy ? "保存中…" : "保存"}
                  icon={Check}
                  disabled={!valid || busy || preparing}
                  onPress={confirmSave}
                />
              </View>
            </>
          ) : null}
          {!original && error ? (
            <ActionButton title="重试" quiet onPress={() => setAttempt((value) => value + 1)} />
          ) : null}
        </ScrollView>
      </KeyboardFrame>
      {crop ? (
        <AvatarCropper image={crop} onCancel={() => setCrop(null)} onConfirm={uploadAvatar} />
      ) : null}
    </SafeAreaView>
  );
}

const createStyles = (C: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.canvas },
  flex: { flex: 1 },
  page: {
    width: "100%",
    maxWidth: 600,
    alignSelf: "center",
    paddingHorizontal: UI.gutter,
    paddingBottom: 48,
  },
  loading: { marginTop: 40 },
  label: { marginTop: 28, marginBottom: 12, fontSize: 14, color: C.muted },
  save: { marginTop: 32, marginBottom: 20 },
  avatarRow: {
    minHeight: 112,
    marginTop: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    padding: 20,
    borderRadius: UI.radius,
    borderCurve: "continuous",
    backgroundColor: C.surface,
  },
  avatarLabel: { flex: 1, color: C.ink, fontSize: 15 },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    overflow: "hidden",
    backgroundColor: C.blueSoft,
    alignItems: "center",
    justifyContent: "center",
  },
});

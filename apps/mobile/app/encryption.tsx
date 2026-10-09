import { useEffect, useRef, useState, type RefObject } from "react";
import { Alert, ScrollView, StyleSheet, Text, View, type TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { KeyRound, ShieldCheck, RotateCw } from "lucide-react-native";
import { encryptionClient } from "../src/api";
import { ActionButton, FormInput, KeyboardFrame, ScreenHeader } from "../src/ui/controls";
import { problemMessage } from "../src/ui/presentation";
import { type Colors, UI } from "../src/ui/theme";
import { useAppTheme, useThemedStyles } from "../src/ui/ThemeProvider";
import { revealKeyboardInput } from "../src/ui/keyboardVisibility";

type Status = Awaited<ReturnType<typeof encryptionClient.status>>;
export default function EncryptionScreen() {
  const styles = useThemedStyles(createStyles);

  const params = useLocalSearchParams<{ uid?: string }>();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [peerUid, setPeerUid] = useState(params.uid ?? "");
  const [fingerprint, setFingerprint] = useState("");
  const [contactExpanded, setContactExpanded] = useState(!!params.uid);
  const [backupImport, setBackupImport] = useState(false);
  const pageScroll = useRef<ScrollView>(null);
  const viewport = useRef<View>(null);
  const focusedInput = useRef<TextInput | null>(null);
  const scrollOffset = useRef(0);
  const revealSequence = useRef(0);
  const codeInput = useRef<TextInput>(null);
  const uidInput = useRef<TextInput>(null);
  const fingerprintInput = useRef<TextInput>(null);

  function revealInput() {
    const input = focusedInput.current;
    const sequence = ++revealSequence.current;
    revealKeyboardInput({
      scroll: pageScroll.current,
      viewport: viewport.current,
      input,
      offset: () => scrollOffset.current,
      isCurrent: () =>
        revealSequence.current === sequence &&
        focusedInput.current === input &&
        !!input?.isFocused(),
    });
  }
  function keyboardInput(ref: RefObject<TextInput | null>) {
    return {
      ref,
      onFocus: () => {
        focusedInput.current = ref.current;
        revealInput();
      },
      onBlur: () => {
        if (focusedInput.current === ref.current) focusedInput.current = null;
        revealSequence.current++;
      },
    };
  }
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      Alert.alert("加密设置未完成", problemMessage(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    try {
      await encryptionClient.ensureReady();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "e2ee_recovery_required") throw error;
    }
    setStatus(await encryptionClient.status());
  }
  useEffect(() => {
    void refresh().catch((error) => Alert.alert("加密服务暂不可用", problemMessage(error)));
  }, []);
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <ScreenHeader title="端到端加密" backLabel="返回设置" onBack={() => router.back()} />
      </View>
      <KeyboardFrame>
        <View ref={viewport} collapsable={false} style={styles.flex} onLayout={revealInput}>
          <ScrollView
            ref={pageScroll}
            automaticallyAdjustKeyboardInsets={false}
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            style={styles.flex}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={styles.page}
            onLayout={revealInput}
            onScroll={({ nativeEvent }) => {
              scrollOffset.current = nativeEvent.contentOffset.y;
            }}
            scrollEventThrottle={16}
          >
            <View style={styles.group}>
              <Text style={styles.heading}>
                {status?.available
                  ? "本机密钥已就绪"
                  : status?.enabled
                    ? "需要恢复本机密钥"
                    : "正在准备本机密钥"}
              </Text>
              <Text style={styles.label}>我的安全码</Text>
              {status?.identity ? (
                <Text selectable style={styles.code}>
                  {status.identity.keyId.match(/.{8}/g)?.join(" ")}
                </Text>
              ) : null}
              <Text style={styles.label}>用户编号</Text>
              <Text selectable style={styles.value}>
                {status?.uid ?? ""}
              </Text>
              <ActionButton
                title="刷新状态"
                icon={RotateCw}
                quiet
                disabled={busy}
                onPress={() => void run(refresh)}
              />
            </View>
            {status?.available ? (
              <ActionButton
                title={status.backupAvailable ? "备份恢复码（可选）" : "保存原恢复码（可选）"}
                icon={KeyRound}
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    if (!status.backupAvailable) {
                      setBackupImport(true);
                      return;
                    }
                    setRecoveryCode(await encryptionClient.backupRecoveryCode());
                  })
                }
              />
            ) : null}
            {recoveryCode ? (
              <View style={styles.group}>
                <Text style={styles.heading}>恢复码</Text>
                <Text selectable style={styles.code}>
                  {recoveryCode}
                </Text>
                <Text style={styles.label}>
                  请保存在安全的地方。手机密钥和恢复码同时丢失后，账号密码不能恢复加密信件。
                </Text>
                <ActionButton
                  title="收起恢复码"
                  icon={KeyRound}
                  quiet
                  onPress={() => setRecoveryCode(null)}
                />
              </View>
            ) : null}
            {status?.enabled && (!status.available || backupImport) ? (
              <View style={styles.group}>
                <FormInput
                  {...keyboardInput(codeInput)}
                  accessibilityLabel="恢复码"
                  placeholder="恢复码"
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={confirmation}
                  onChangeText={setConfirmation}
                />
                <ActionButton
                  title={status.available ? "保存原恢复码" : "恢复密钥"}
                  icon={KeyRound}
                  disabled={busy || !confirmation}
                  onPress={() =>
                    void run(async () => {
                      await encryptionClient.recover(confirmation);
                      setConfirmation("");
                      setBackupImport(false);
                      await refresh();
                    })
                  }
                />
              </View>
            ) : null}
            {status?.available ? (
              <ActionButton
                title="核验联系人（可选）"
                icon={ShieldCheck}
                quiet
                onPress={() => setContactExpanded(!contactExpanded)}
              />
            ) : null}
            {status?.available && contactExpanded ? (
              <View style={styles.group}>
                <Text style={styles.heading}>核对联系人安全码</Text>
                <FormInput
                  {...keyboardInput(uidInput)}
                  accessibilityLabel="联系人用户编号"
                  placeholder="对方的 8 位用户编号"
                  keyboardType="number-pad"
                  maxLength={8}
                  value={peerUid}
                  onChangeText={setPeerUid}
                />
                <FormInput
                  {...keyboardInput(fingerprintInput)}
                  accessibilityLabel="对方亲自提供的安全码"
                  placeholder="对方亲自提供的安全码"
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                  scrollEnabled
                  style={styles.fingerprintInput}
                  value={fingerprint}
                  onChangeText={setFingerprint}
                />
                <ActionButton
                  title="核对并保存"
                  icon={ShieldCheck}
                  disabled={busy || !peerUid || !fingerprint}
                  onPress={() =>
                    void run(async () => {
                      await encryptionClient.verifyContact(peerUid, fingerprint);
                      setFingerprint("");
                      Alert.alert("安全码已核对");
                    })
                  }
                />
              </View>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardFrame>
    </SafeAreaView>
  );
}
const createStyles = (C: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.canvas },
  flex: { flex: 1 },
  header: { paddingHorizontal: 20 },
  page: {
    width: "100%",
    maxWidth: 600,
    alignSelf: "center",
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 16,
    paddingBottom: 40,
  },
  group: { padding: 20, gap: 14, backgroundColor: C.surface, borderRadius: UI.radius },
  heading: { fontSize: 17, color: C.ink, fontWeight: "600" },
  label: { fontSize: 13, color: C.muted },
  value: { fontSize: 15, color: C.ink },
  code: { fontSize: 15, lineHeight: 24, color: C.ink },
  fingerprintInput: { maxHeight: 120 },
});

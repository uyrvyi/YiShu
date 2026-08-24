import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { TRANSPORT_TYPES, type TransportType } from "@yishu/shared";

const TRANSPORT_LABELS: Record<TransportType, string> = {
  HAND_CARRY: "托人捎信",
  HORSE_RELAY: "驿马",
  EXPRESS_RELAY: "加急驿递",
  PIGEON: "飞鸽传书",
};

const MAX_CONTENT = 2000;

/** 按 Unicode code points 计数正文长度。 */
function contentLength(v: string): number {
  return Array.from(v).length;
}

/** 写信页（Phase 3 最小真实流程）：搜索收件人 → 确认 → 正文 → 运输方式 → 寄出。 */
export default function NewLetterScreen() {
  // 每个草稿只生成一次稳定幂等键（重试不重复创建）
  const idempotencyKeyRef = useRef<string | null>(null);
  if (!idempotencyKeyRef.current) {
    idempotencyKeyRef.current = `cr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const [recipientInput, setRecipientInput] = useState("");
  const [recipient, setRecipient] = useState<{
    account: string;
    uid: string;
    nickname: string;
  } | null>(null);
  const [content, setContent] = useState("");
  const [transportType, setTransportType] = useState<TransportType>("HORSE_RELAY");
  const [error, setError] = useState<string | null>(null);

  function handleRecipientInput(v: string) {
    setRecipientInput(v);
    // 输入变化时清除已确认状态（防止发给其他用户）
    setRecipient(null);
  }

  async function searchRecipient() {
    try {
      setError(null);
      const { getApi } = await import("../../src/api/index");
      const result = await getApi().searchRecipient(recipientInput.trim());
      setRecipient({ account: result.account, uid: result.uid, nickname: result.nickname });
    } catch (e) {
      setRecipient(null);
      setError((e as Error).message === "user_not_found" ? "未找到该用户" : (e as Error).message);
    }
  }

  async function send() {
    // 必须已确认收件人，禁止直接发送未确认输入
    if (!recipient) {
      setError("请先搜索并确认收件人");
      return;
    }
    try {
      setError(null);
      const { getApi } = await import("../../src/api/index");
      await getApi().createLetter({
        recipient: recipient.uid,
        content,
        transportType,
        clientRequestId: idempotencyKeyRef.current ?? `cr-${Date.now()}`,
      });
      router.replace("/letters");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const contentLen = contentLength(content);
  const overLimit = contentLen > MAX_CONTENT;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>写信</Text>
      <TextInput
        style={styles.input}
        placeholder="收件人 account 或 8 位 UID"
        value={recipientInput}
        onChangeText={handleRecipientInput}
      />
      <Pressable style={styles.button} onPress={() => void searchRecipient()}>
        <Text style={styles.buttonText}>搜索</Text>
      </Pressable>
      {recipient ? (
        <Text style={styles.recipient}>
          收件人：{recipient.nickname}（{recipient.uid}）
        </Text>
      ) : null}
      <TextInput
        style={[styles.input, styles.contentInput]}
        placeholder="正文（纯文字，最多 2000 字）"
        value={content}
        onChangeText={setContent}
        multiline
      />
      <Text style={overLimit ? styles.error : styles.counter}>
        {contentLen}/{MAX_CONTENT}
      </Text>
      <Text>运输方式：</Text>
      <View style={styles.transportRow}>
        {TRANSPORT_TYPES.map((t) => (
          <Pressable
            key={t}
            style={[styles.transportChip, transportType === t && styles.transportChipActive]}
            onPress={() => setTransportType(t)}
          >
            <Text style={transportType === t ? styles.chipActiveText : undefined}>
              {TRANSPORT_LABELS[t]}
            </Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        style={[styles.button, (overLimit || !recipient) && styles.buttonDisabled]}
        onPress={() => void send()}
        disabled={overLimit || !recipient}
      >
        <Text style={styles.buttonText}>寄出</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", padding: 16 },
  title: { fontSize: 20, fontWeight: "600", marginBottom: 8 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10, marginBottom: 8 },
  contentInput: { minHeight: 120, textAlignVertical: "top" },
  button: {
    backgroundColor: "#1a73e8",
    padding: 12,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 8,
  },
  buttonDisabled: { backgroundColor: "#ccc" },
  buttonText: { color: "#fff", fontWeight: "600" },
  recipient: { marginBottom: 8, color: "#333" },
  counter: { marginBottom: 4, color: "#666" },
  transportRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 8 },
  transportChip: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  transportChipActive: { backgroundColor: "#1a73e8", borderColor: "#1a73e8" },
  chipActiveText: { color: "#fff" },
  error: { color: "red", marginTop: 8 },
});

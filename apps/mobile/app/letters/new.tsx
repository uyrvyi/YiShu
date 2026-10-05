import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Check,
  Clock3,
  FolderOpen,
  ImagePlus,
  RotateCw,
  Search,
  Send,
  X,
} from "lucide-react-native";
import {
  TRANSPORT_TYPES,
  TRANSPORT_SPEEDS_KM_PER_DAY,
  type TransportEstimate,
  type TransportType,
} from "@yishu/shared";
import { getApi, getSessionVersion } from "../../src/api";
import { AuthExpiredError } from "../../src/api/authenticatedFetch";
import {
  LetterApiError,
  type CreateLetterInput,
  type LetterImage,
  type UserSearchResult,
  type UploadImageInput,
} from "../../src/api/letterApi";
import { MAX_LETTER_IMAGES, pickImages } from "../../src/media/picker";
import { prepareDraftPreview } from "../../src/media/draftPreview";
import { prepareUploadImage } from "../../src/media/uploadPreparation";
import { PrivateAvatar } from "../../src/media/PrivateImage";
import { ImagePreview } from "../../src/media/ImagePreview";
import { createDraftMediaLifecycle } from "../../src/media/draftMediaLifecycle";
import { UploadProgressRing } from "../../src/media/UploadProgressRing";
import { ActionButton, FormInput, Notice, ScreenHeader } from "../../src/ui/controls";
import { problemMessage, TRANSPORT_LABELS } from "../../src/ui/presentation";
import { C, UI } from "../../src/ui/theme";
import { formatEstimatedDuration, TRANSPORT_DESCRIPTIONS } from "../../src/ui/transport";

const MAX_CONTENT = 2000;
interface DraftUpload {
  id: string;
  input: UploadImageInput;
  localUri: string;
  phase: "queued" | "preparing" | "uploading" | "failed";
  progress: number | null;
  prepared?: boolean;
  optimized?: boolean;
}

type PreparedUpload = { job: DraftUpload } | { failure: unknown };

export default function NewLetterScreen() {
  const idempotencyKey = useRef(`cr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const requestSequence = useRef(0);
  const sending = useRef(false);
  const writtenAt = useRef<string | null>(null);
  const createRequest = useRef<CreateLetterInput | null>(null);
  const picking = useRef(false);
  const draftMedia = useRef<ReturnType<typeof createDraftMediaLifecycle> | null>(null);
  if (!draftMedia.current) {
    const generation = getSessionVersion();
    draftMedia.current = createDraftMediaLifecycle({
      sameSession: () => generation === getSessionVersion(),
      remove: (id) => getApi().deleteStagedImage(id),
    });
  }
  const [images, setImages] = useState<Array<LetterImage & { localUri: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [recipientInput, setRecipientInput] = useState("");
  const [recipient, setRecipient] = useState<UserSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [content, setContent] = useState("");
  const [transportType, setTransportType] = useState<TransportType>("HORSE_RELAY");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingTrackingNo, setPendingTrackingNo] = useState<string | null>(null);
  const [estimates, setEstimates] = useState<TransportEstimate[] | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [uploads, setUploads] = useState<DraftUpload[]>([]);
  const recipientUid = recipient?.uid;
  const previewImage = images.find((image) => image.localUri === previewUri);
  const selectedEstimate = estimates?.find((estimate) => estimate.transportType === transportType);
  const draftLocked = busy || !!pendingTrackingNo || createRequest.current !== null;

  useEffect(() => {
    const lifecycle = draftMedia.current!;
    lifecycle.activate();
    return () => {
      // A failed response may already have bound these images to a letter.
      void lifecycle.dispose(createRequest.current !== null);
    };
  }, []);

  useEffect(() => {
    let active = true;
    setEstimates(null);
    setEstimateError(false);
    setEstimating(!!recipientUid);
    if (recipientUid) {
      void getApi()
        .getTransportEstimates(recipientUid)
        .then((result) => {
          if (active) setEstimates(result);
        })
        .catch((failure: unknown) => {
          if (!active) return;
          if (failure instanceof AuthExpiredError) router.replace("/");
          setEstimateError(true);
        })
        .finally(() => {
          if (active) setEstimating(false);
        });
    }
    return () => {
      active = false;
    };
  }, [recipientUid]);
  const contentLength = Array.from(content).length;
  const valid = !!recipient && content.trim().length > 0 && contentLength <= MAX_CONTENT;

  function changeContent(value: string) {
    if (draftLocked) return;
    if (!writtenAt.current && value.length > 0) writtenAt.current = new Date().toISOString();
    setContent(value);
  }

  async function addImages(source: "album" | "files") {
    if (picking.current || draftLocked) return;
    picking.current = true;
    setUploading(true);
    setUploadStatus("正在准备图片…");
    try {
      const selected = await pickImages(
        source,
        MAX_LETTER_IMAGES - images.length - uploads.length,
        {
          prepare: false,
        }
      );
      if (selected.length && !writtenAt.current) writtenAt.current = new Date().toISOString();
      const jobs: DraftUpload[] = selected.map((input, index) => ({
        id: `upload-${Date.now()}-${index}`,
        input,
        localUri: input.uri,
        phase: "queued",
        progress: 0,
      }));
      setUploads((previous) => [...previous, ...jobs]);
      let added = 0;
      let firstFailure: unknown;
      let nextPreparation: Promise<PreparedUpload> | undefined;
      try {
        for (let index = 0; index < jobs.length; index++) {
          const prepared = await (nextPreparation ?? prepareImage(jobs[index]!));
          nextPreparation = jobs[index + 1] ? prepareImage(jobs[index + 1]!) : undefined;
          try {
            if ("failure" in prepared) throw prepared.failure;
            await uploadOne(prepared.job);
            added++;
          } catch (failure) {
            firstFailure ??= failure;
            if (failure instanceof AuthExpiredError) throw failure;
          }
        }
      } finally {
        // Preparation does not send requests; settle the one-ahead task even if auth expires.
        await nextPreparation;
      }
      if (firstFailure)
        Alert.alert(
          added ? "部分图片未上传" : "图片未上传",
          `已添加 ${added} 张。${problemMessage(firstFailure)}\n可点击失败图片重试，或移除后继续。`
        );
    } catch (failure) {
      if (failure instanceof AuthExpiredError) router.replace("/");
      else {
        const message = problemMessage(failure);
        Alert.alert("图片未上传", message);
      }
    } finally {
      picking.current = false;
      setUploading(false);
      setUploadStatus("");
    }
  }

  function updateUpload(id: string, patch: Partial<DraftUpload>) {
    setUploads((previous) =>
      previous.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }

  async function prepareImage(job: DraftUpload): Promise<PreparedUpload> {
    if (job.prepared) return { job };
    try {
      updateUpload(job.id, { phase: "preparing", progress: null });
      const input = job.optimized ? job.input : await prepareUploadImage(job.input);
      // Retain the compressed file for retries even when thumbnail preparation fails.
      updateUpload(job.id, { input, optimized: true });
      const localUri = await prepareDraftPreview(input.uri, input.mimeType);
      const prepared: DraftUpload = {
        ...job,
        input,
        localUri,
        prepared: true,
        optimized: true,
        phase: "queued",
        progress: 0,
      };
      updateUpload(job.id, prepared);
      return { job: prepared };
    } catch (failure) {
      updateUpload(job.id, { phase: "failed" });
      return { failure };
    }
  }

  async function uploadOne(job: DraftUpload) {
    const update = (patch: Partial<DraftUpload>) => updateUpload(job.id, patch);
    try {
      setUploadStatus("正在准备图片…");
      const prepared = await prepareImage(job);
      if ("failure" in prepared) throw prepared.failure;
      const { localUri, input } = prepared.job;
      update({ localUri, phase: "uploading", progress: 0 });
      setUploadStatus("正在上传图片…");
      const uploaded = await getApi().uploadImage(input, false, (progress) => update({ progress }));
      draftMedia.current!.add(uploaded.id);
      setImages((previous) => [...previous, { ...uploaded, localUri }]);
      setUploads((previous) => previous.filter((item) => item.id !== job.id));
    } catch (failure) {
      update({ phase: "failed" });
      throw failure;
    }
  }

  async function retryImage(job: DraftUpload) {
    if (picking.current || draftLocked) return;
    picking.current = true;
    setUploading(true);
    try {
      await uploadOne(job);
    } catch (failure) {
      if (failure instanceof AuthExpiredError) router.replace("/");
      else Alert.alert("图片未上传", problemMessage(failure));
    } finally {
      picking.current = false;
      setUploading(false);
      setUploadStatus("");
    }
  }

  async function removeImage(id: string) {
    if (picking.current || draftLocked) return;
    picking.current = true;
    setUploading(true);
    try {
      if (uploads.some((job) => job.id === id)) {
        setUploads((previous) => previous.filter((job) => job.id !== id));
        return;
      }
      await getApi().deleteStagedImage(id);
      draftMedia.current!.forget(id);
      setImages((previous) => previous.filter((image) => image.id !== id));
    } catch (failure) {
      if (failure instanceof LetterApiError && failure.status === 404)
        setImages((previous) => previous.filter((image) => image.id !== id));
      else if (failure instanceof AuthExpiredError) router.replace("/");
      else Alert.alert("图片未移除", problemMessage(failure));
    } finally {
      picking.current = false;
      setUploading(false);
    }
  }

  function confirmRemoveImage(id: string) {
    if (picking.current || draftLocked) return;
    Alert.alert("移除这张图片？", "确认后将从这封信的草稿中移除。", [
      { text: "取消", style: "cancel" },
      { text: "移除", style: "destructive", onPress: () => void removeImage(id) },
    ]);
  }

  function changeRecipient(value: string) {
    if (draftLocked) return;
    requestSequence.current++;
    setSearching(false);
    setRecipientInput(value);
    setRecipient(null);
  }

  async function searchRecipient() {
    if (draftLocked) return;
    const query = recipientInput.trim();
    if (!query) {
      Alert.alert("请输入收件人", "请输入完整账号或 8 位 UID");
      return;
    }
    const sequence = ++requestSequence.current;
    setSearching(true);
    try {
      const result = await getApi().searchRecipient(query);
      if (requestSequence.current === sequence) setRecipient(result);
    } catch (failure) {
      if (requestSequence.current === sequence) {
        if (failure instanceof AuthExpiredError) router.replace("/");
        else Alert.alert("收件人未找到", problemMessage(failure));
      }
    } finally {
      if (requestSequence.current === sequence) setSearching(false);
    }
  }

  async function send() {
    if (
      sending.current ||
      picking.current ||
      uploads.length > 0 ||
      (!valid && !pendingTrackingNo && !createRequest.current)
    )
      return;
    sending.current = true;
    requestSequence.current++;
    setSearching(false);
    setBusy(true);
    setConfirm(false);
    let created = !!pendingTrackingNo;
    try {
      let trackingNo = pendingTrackingNo;
      if (!trackingNo) {
        if (!createRequest.current) {
          if (!recipient) return;
          createRequest.current = {
            recipient: recipient.uid,
            content,
            transportType,
            clientRequestId: idempotencyKey.current,
            writtenAt: writtenAt.current ?? new Date().toISOString(),
            imageIds: images.map((image) => image.id),
          };
        }
        const letter = await getApi().createLetter(createRequest.current);
        trackingNo = letter.trackingNo;
        created = true;
        setPendingTrackingNo(trackingNo);
      }
      await getApi().initializeJourney(trackingNo);
      router.replace(`/letters/${trackingNo}`);
    } catch (failure) {
      // A timeout may have committed: retry the identical request rather than create a duplicate.
      if (
        !created &&
        failure instanceof LetterApiError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        failure.status !== 409
      ) {
        createRequest.current = null;
        idempotencyKey.current = `cr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      }
      if (failure instanceof AuthExpiredError) router.replace("/");
      else Alert.alert(created ? "路线未建立" : "发送未完成", problemMessage(failure));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.page}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <ScreenHeader
            title="写信"
            backLabel="返回信件"
            onBack={() => (router.canGoBack() ? router.back() : router.replace("/letters"))}
          />
          {pendingTrackingNo ? (
            <Notice tone="info">
              信件已保存，编号 {pendingTrackingNo}。路线尚未建立，可以重试或打开信件查看。
            </Notice>
          ) : null}
          {!pendingTrackingNo && createRequest.current ? (
            <Notice tone="info">发送结果尚未确认，请重试确认这封信的状态。</Notice>
          ) : null}
          <Text style={styles.section}>收件人</Text>
          <View style={styles.searchRow}>
            <FormInput
              style={styles.searchInput}
              placeholder="完整账号或 8 位 UID"
              placeholderTextColor={C.muted}
              value={recipientInput}
              onChangeText={changeRecipient}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="收件人账号或 UID"
              editable={!draftLocked}
            />
            <Pressable
              style={({ pressed }) => [
                styles.searchButton,
                (pressed || searching || draftLocked) && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="搜索收件人"
              onPress={() => void searchRecipient()}
              disabled={searching || draftLocked}
            >
              {searching ? (
                <ActivityIndicator color={C.surface} />
              ) : (
                <Search color={C.surface} size={21} />
              )}
            </Pressable>
          </View>
          {recipient ? (
            <View style={styles.recipient}>
              <Check color={C.green} size={19} />
              <View style={styles.recipientText}>
                <Text style={styles.recipientName}>
                  {recipient.nickname} · {recipient.account}
                </Text>
                <Text style={styles.recipientMeta}>
                  UID {recipient.uid} · {recipient.region.province}
                  {recipient.region.city}
                  {recipient.region.district}
                </Text>
              </View>
              <View
                style={styles.recipientAvatar}
                accessibilityLabel="收件人头像"
                testID="recipient-avatar"
              >
                {recipient.avatarUrl ? (
                  <PrivateAvatar url={recipient.avatarUrl} />
                ) : (
                  <Text style={styles.recipientInitial}>
                    {Array.from(recipient.nickname)[0] ?? "信"}
                  </Text>
                )}
              </View>
            </View>
          ) : null}
          <Text style={styles.section}>正文</Text>
          <FormInput
            style={styles.bodyInput}
            placeholder="写下想说的话"
            placeholderTextColor={C.muted}
            value={content}
            onChangeText={changeContent}
            multiline
            textAlignVertical="top"
            accessibilityLabel="信件正文"
            editable={!draftLocked}
          />
          <Text style={[styles.counter, contentLength > MAX_CONTENT && styles.overLimit]}>
            {contentLength} / {MAX_CONTENT}
          </Text>
          <View style={styles.imageToolbar}>
            <Pressable
              style={styles.imageCommand}
              accessibilityRole="button"
              accessibilityLabel="从相册添加图片"
              disabled={
                uploading || draftLocked || images.length + uploads.length >= MAX_LETTER_IMAGES
              }
              onPress={() => void addImages("album")}
            >
              <ImagePlus size={21} color={C.green} />
              <Text style={styles.imageCommandText}>相册</Text>
            </Pressable>
            <Pressable
              style={styles.imageCommand}
              accessibilityRole="button"
              accessibilityLabel="从文件添加图片"
              disabled={
                uploading || draftLocked || images.length + uploads.length >= MAX_LETTER_IMAGES
              }
              onPress={() => void addImages("files")}
            >
              <FolderOpen size={21} color={C.blue} />
              <Text style={styles.imageCommandText}>文件</Text>
            </Pressable>
            {uploading ? <ActivityIndicator color={C.green} size="small" /> : null}
            <Text style={styles.imageCount}>
              {images.length + uploads.length} / {MAX_LETTER_IMAGES}
            </Text>
          </View>
          {uploading && uploadStatus ? (
            <Text accessibilityLiveRegion="polite" style={styles.imageCommandText}>
              {uploadStatus}
            </Text>
          ) : null}
          {images.length || uploads.length ? (
            <View style={styles.images}>
              {images.map((image) => (
                <View key={image.id} style={styles.imageTile}>
                  <Pressable
                    style={styles.thumbnail}
                    accessibilityRole="button"
                    accessibilityLabel="预览信件图片"
                    onPress={() => setPreviewUri(image.localUri)}
                  >
                    <Image
                      source={{ uri: image.localUri }}
                      resizeMode="cover"
                      style={styles.thumbnail}
                      onError={() =>
                        Alert.alert("图片无法预览", "预览加载失败，请移除这张图片后重新选择。")
                      }
                    />
                  </Pressable>
                  {!draftLocked ? (
                    <Pressable
                      style={styles.removeImage}
                      accessibilityRole="button"
                      accessibilityLabel="移除图片"
                      disabled={uploading || busy}
                      onPress={() => confirmRemoveImage(image.id)}
                      hitSlop={8}
                    >
                      <X size={17} color={C.surface} />
                    </Pressable>
                  ) : null}
                </View>
              ))}
              {uploads.map((job) => (
                <View key={job.id} style={styles.imageTile}>
                  <Pressable
                    style={styles.thumbnail}
                    accessibilityRole="button"
                    accessibilityLabel={
                      job.phase === "failed" ? "重试上传图片" : "预览上传中的图片"
                    }
                    disabled={job.phase === "failed" && (uploading || draftLocked)}
                    onPress={() =>
                      job.phase === "failed" ? void retryImage(job) : setPreviewUri(job.localUri)
                    }
                  >
                    <Image
                      source={{ uri: job.localUri }}
                      resizeMode="cover"
                      style={styles.thumbnail}
                    />
                    <UploadProgressRing phase={job.phase} progress={job.progress} />
                  </Pressable>
                  {job.phase === "failed" && !draftLocked ? (
                    <>
                      <View style={styles.retryImage} pointerEvents="none">
                        <RotateCw size={16} color={C.surface} />
                      </View>
                      <Pressable
                        style={styles.removeImage}
                        accessibilityRole="button"
                        accessibilityLabel="移除未上传图片"
                        disabled={uploading}
                        onPress={() => confirmRemoveImage(job.id)}
                        hitSlop={8}
                      >
                        <X size={17} color={C.surface} />
                      </Pressable>
                    </>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
          <Text style={styles.section}>寄送方式</Text>
          <View style={styles.transportGrid}>
            {TRANSPORT_TYPES.map((type) => (
              <Pressable
                key={type}
                style={({ pressed }) => [
                  styles.transport,
                  transportType === type && styles.transportSelected,
                  pressed && styles.pressed,
                ]}
                accessibilityRole="radio"
                accessibilityState={{ checked: transportType === type }}
                onPress={() => setTransportType(type)}
                disabled={draftLocked}
              >
                <View style={[styles.radio, transportType === type && styles.radioSelected]} />
                <Text
                  style={[
                    styles.transportText,
                    transportType === type && styles.transportTextSelected,
                  ]}
                >
                  {TRANSPORT_LABELS[type]}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.transportInfo} accessibilityLiveRegion="polite">
            <Text style={styles.transportInfoTitle}>{TRANSPORT_LABELS[transportType]}</Text>
            <Text style={styles.transportDescription}>{TRANSPORT_DESCRIPTIONS[transportType]}</Text>
            <Text style={styles.transportSpeed}>
              参考速度 · {TRANSPORT_SPEEDS_KM_PER_DAY[transportType]} 公里 / 天
            </Text>
            <View style={styles.estimateRow}>
              <Clock3 size={16} color={C.green} />
              <Text style={styles.estimateText}>
                预计寄送用时 ·{" "}
                {!recipient
                  ? "待确认收件人"
                  : estimating
                    ? "计算中…"
                    : estimateError
                      ? "暂不可用"
                      : selectedEstimate
                        ? `约 ${formatEstimatedDuration(selectedEstimate.durationSeconds)}`
                        : estimates
                          ? "当前方式暂无可用路线"
                          : "计算中…"}
              </Text>
            </View>
            {selectedEstimate && recipient ? (
              <Text style={styles.estimateNote}>
                按当前寄收地区与正常运输估算，含末端派送；途中变化可能使送达延后。
              </Text>
            ) : null}
          </View>
          <View style={styles.bottom}>
            {pendingTrackingNo ? (
              <>
                <ActionButton
                  title={busy ? "正在建立路线…" : "重试建立路线"}
                  onPress={() => void send()}
                  disabled={busy}
                />
                <View style={styles.secondary}>
                  <ActionButton
                    title="查看已保存的信"
                    quiet
                    onPress={() => router.replace(`/letters/${pendingTrackingNo}`)}
                  />
                </View>
              </>
            ) : (
              <ActionButton
                title="继续"
                icon={Send}
                onPress={() => {
                  Keyboard.dismiss();
                  setConfirm(true);
                }}
                disabled={!valid || busy || uploading || uploads.length > 0}
              />
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      {previewUri ? (
        <ImagePreview
          aspectRatio={previewImage ? previewImage.width / previewImage.height : 1}
          onClose={() => setPreviewUri(null)}
        >
          <Image
            source={{ uri: previewUri }}
            resizeMode="contain"
            style={styles.fullImage}
            onError={() => Alert.alert("图片无法预览", "请关闭后重试，或重新选择图片。")}
          />
        </ImagePreview>
      ) : null}
      <Modal
        visible={confirm}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirm(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modal} accessibilityViewIsModal>
            <ScrollView
              style={styles.modalScroll}
              contentContainerStyle={styles.modalContent}
              bounces={false}
            >
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>确认寄出</Text>
                <Pressable
                  style={styles.closeButton}
                  accessibilityRole="button"
                  accessibilityLabel="关闭确认"
                  onPress={() => setConfirm(false)}
                >
                  <X size={22} color={C.ink} />
                </Pressable>
              </View>
              <Text style={styles.confirmLine}>
                寄给 {recipient?.nickname} · {recipient?.uid}
              </Text>
              <Text style={styles.confirmLine}>方式 {TRANSPORT_LABELS[transportType]}</Text>
              {images.length ? (
                <Text style={styles.confirmLine}>图片 {images.length} 张</Text>
              ) : null}
              <Text style={styles.preview} numberOfLines={5}>
                {content}
              </Text>
              <ActionButton
                title={busy ? "寄送中…" : "确认寄出"}
                icon={Send}
                onPress={() => void send()}
                disabled={busy}
              />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.surface },
  keyboard: { flex: 1 },
  page: {
    width: "100%",
    maxWidth: 600,
    alignSelf: "center",
    paddingHorizontal: UI.gutter,
    paddingBottom: 48,
  },
  section: { color: C.ink, fontSize: 14, fontWeight: "600", marginTop: 28, marginBottom: 13 },
  searchRow: { flexDirection: "row", gap: 8 },
  searchInput: { flex: 1, minWidth: 0 },
  searchButton: {
    width: UI.controlHeight,
    minHeight: UI.controlHeight,
    borderRadius: UI.radius,
    backgroundColor: C.green,
    alignItems: "center",
    justifyContent: "center",
  },
  recipient: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 12,
    padding: 15,
    borderRadius: UI.radius,
    backgroundColor: C.greenSoft,
  },
  recipientText: { flex: 1, minWidth: 0 },
  recipientAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    overflow: "hidden",
    backgroundColor: C.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  recipientInitial: { color: C.green, fontSize: 20, fontWeight: "600" },
  recipientName: { color: C.ink, fontSize: 15, fontWeight: "600", lineHeight: 23 },
  recipientMeta: { color: C.muted, fontSize: 12, lineHeight: 19, marginTop: 5 },
  bodyInput: {
    minHeight: 220,
    paddingVertical: 16,
    fontSize: 16,
    lineHeight: 28,
    backgroundColor: "#FAFBFC",
  },
  counter: { textAlign: "right", color: C.muted, fontSize: 12, marginTop: 6 },
  overLimit: { color: C.error },
  imageToolbar: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 8 },
  imageCommand: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 },
  imageCommandText: { color: C.muted, fontSize: 13 },
  imageCount: { marginLeft: "auto", color: C.muted, fontSize: 12 },
  images: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  imageTile: {
    width: "30%",
    aspectRatio: 1,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: C.canvas,
  },
  thumbnail: { width: "100%", height: "100%" },
  fullImage: { width: "100%", height: "100%" },
  removeImage: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#202629A0",
  },
  retryImage: {
    position: "absolute",
    bottom: 5,
    right: 5,
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  transportGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  transport: {
    flexBasis: "45%",
    flexGrow: 1,
    minHeight: 56,
    paddingVertical: 12,
    borderRadius: UI.radius,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: C.surface,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 11,
    gap: 8,
  },
  transportSelected: { borderColor: C.green, backgroundColor: C.greenSoft },
  radio: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: C.muted },
  radioSelected: { borderColor: C.green, borderWidth: 4 },
  transportText: { color: C.ink, fontSize: 13, flexShrink: 1 },
  transportTextSelected: { color: C.green, fontWeight: "600" },
  transportInfo: {
    marginTop: 18,
    paddingVertical: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  transportInfoTitle: { fontSize: 15, fontWeight: "600", color: C.ink },
  transportDescription: { marginTop: 9, color: C.ink, fontSize: 14, lineHeight: 23 },
  transportSpeed: { marginTop: 9, color: C.muted, fontSize: 12, lineHeight: 19 },
  estimateRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14 },
  estimateText: { color: C.green, fontSize: 14, lineHeight: 22, fontWeight: "500", flex: 1 },
  estimateNote: { marginTop: 9, color: C.muted, fontSize: 12, lineHeight: 19 },
  pressed: { opacity: UI.pressedOpacity },
  error: { marginTop: 20 },
  bottom: { marginTop: 30 },
  secondary: { marginTop: 10 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "#20262980",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  modal: {
    width: "100%",
    maxWidth: 460,
    borderRadius: UI.radius,
    backgroundColor: C.surface,
    maxHeight: "90%",
  },
  modalScroll: { flexGrow: 0, flexShrink: 1 },
  modalContent: { padding: 24 },
  closeButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 19,
  },
  modalTitle: { color: C.ink, fontSize: 18, fontWeight: "600", flex: 1 },
  confirmLine: { color: C.ink, fontSize: 14, lineHeight: 22, marginBottom: 10 },
  preview: {
    padding: 13,
    backgroundColor: C.canvas,
    color: C.ink,
    lineHeight: 23,
    minHeight: 100,
    marginVertical: 10,
  },
});

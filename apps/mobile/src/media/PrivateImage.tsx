import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { RotateCw } from "lucide-react-native";
import { ImagePreview } from "./ImagePreview";
import { getApi, getSessionVersion, subscribeSession } from "../api";
import type { LetterImage } from "../api/letterApi";
import { C, UI } from "../ui/theme";

function ProtectedPixels({
  id,
  preview,
  aspectRatio,
  fullscreen = false,
}: {
  id: string;
  preview: boolean;
  aspectRatio?: number;
  fullscreen?: boolean;
}) {
  const generation = useSyncExternalStore(subscribeSession, getSessionVersion, getSessionVersion);
  const [pixels, setPixels] = useState<{ id: string; generation: number; data: string } | null>(
    null
  );
  const data = pixels?.id === id && pixels.generation === generation ? pixels.data : null;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setPixels(null);
    setFailed(false);
    void getApi()
      .getImageData(id, preview)
      .then((result) => {
        if (active && generation === getSessionVersion())
          setPixels({ id, generation, data: result });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [id, preview, attempt, generation]);
  const dimensions = aspectRatio ? { aspectRatio } : { flex: 1 };
  return (
    <View style={[styles.pixels, dimensions, fullscreen && styles.fullscreen]}>
      {data ? (
        <Image source={{ uri: data }} resizeMode="contain" style={StyleSheet.absoluteFill} />
      ) : failed ? (
        <Pressable
          style={styles.retry}
          accessibilityRole="button"
          accessibilityLabel="重新加载图片"
          onPress={() => setAttempt((value) => value + 1)}
        >
          <RotateCw color={C.muted} size={22} />
          <Text style={styles.error}>图片暂不可用</Text>
        </Pressable>
      ) : (
        <ActivityIndicator color={C.green} />
      )}
    </View>
  );
}

export function PrivateImage({ image }: { image: LetterImage }) {
  const [expanded, setExpanded] = useState(false);
  const generation = useSyncExternalStore(subscribeSession, getSessionVersion, getSessionVersion);
  useEffect(() => {
    setExpanded(false);
  }, [generation]);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="查看完整图片"
        onPress={() => setExpanded(true)}
        style={styles.frame}
      >
        <ProtectedPixels
          id={image.id}
          preview
          aspectRatio={Math.max(0.5, Math.min(2, image.width / image.height))}
        />
      </Pressable>
      {expanded ? (
        <ImagePreview aspectRatio={image.width / image.height} onClose={() => setExpanded(false)}>
          <ProtectedPixels id={image.id} preview={false} fullscreen />
        </ImagePreview>
      ) : null}
    </>
  );
}

export function PrivateAvatar({ url }: { url: string }) {
  const id = url.match(/^\/api\/v1\/media\/([0-9a-f-]{36})$/i)?.[1];
  return id ? <ProtectedPixels id={id} preview aspectRatio={1} /> : null;
}

const styles = StyleSheet.create({
  frame: { borderRadius: UI.radius, overflow: "hidden", marginTop: 12 },
  pixels: {
    width: "100%",
    backgroundColor: C.canvas,
    alignItems: "center",
    justifyContent: "center",
  },
  fullscreen: { backgroundColor: "transparent" },
  retry: { minHeight: 64, alignItems: "center", justifyContent: "center", gap: 8 },
  error: { color: C.muted, fontSize: 12 },
});

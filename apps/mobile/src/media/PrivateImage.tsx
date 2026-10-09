import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { RotateCw } from "lucide-react-native";
import { ImagePreview } from "./ImagePreview";
import { createPrivateImageCache, type PrivatePixels } from "./privateImageCache";
import { getApi, getSessionVersion, subscribeSession } from "../api";
import type { LetterImage } from "../api/letterApi";
import { type Colors, UI } from "../ui/theme";
import { useAppTheme, useThemedStyles } from "../ui/ThemeProvider";

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
  return (
    <ImagePixels
      id={id}
      pixels={data ? { status: "ready", data } : { status: failed ? "failed" : "loading" }}
      aspectRatio={aspectRatio}
      fullscreen={fullscreen}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}

function ImagePixels({
  id,
  pixels,
  aspectRatio,
  fullscreen = false,
  onRetry,
}: {
  id: string;
  pixels?: PrivatePixels;
  aspectRatio?: number;
  fullscreen?: boolean;
  onRetry: () => void;
}) {
  const { colors: C } = useAppTheme();
  const styles = useThemedStyles(createStyles);

  const dimensions = aspectRatio ? { aspectRatio } : { flex: 1 };
  return (
    <View
      testID={`private-image-${id}`}
      style={[styles.pixels, dimensions, fullscreen && styles.fullscreen]}
    >
      {pixels?.status === "ready" ? (
        <Image source={{ uri: pixels.data }} resizeMode="contain" style={StyleSheet.absoluteFill} />
      ) : pixels?.status === "failed" ? (
        <Pressable
          style={styles.retry}
          accessibilityRole="button"
          accessibilityLabel="重新加载图片"
          onPress={onRetry}
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

export function PrivateImages({ images }: { images: LetterImage[] }) {
  const styles = useThemedStyles(createStyles);

  const [activeId, setActiveId] = useState<string | null>(null);
  const index = images.findIndex((item) => item.id === activeId);
  const activeImage = images[index];
  const generation = useSyncExternalStore(subscribeSession, getSessionVersion, getSessionVersion);
  const idsKey = JSON.stringify(images.map((image) => image.id));
  const cache = useMemo(
    () =>
      createPrivateImageCache({
        ids: JSON.parse(idsKey) as string[],
        loadImage: (id) =>
          getApi().getImageData(id, false, images.find((image) => image.id === id)?.encryption),
        sameSession: () => generation === getSessionVersion(),
      }),
    [idsKey, generation]
  );
  useSyncExternalStore(cache.subscribe, cache.getVersion, cache.getVersion);
  useEffect(() => {
    cache.preload();
    return () => cache.dispose();
  }, [cache]);
  useEffect(() => {
    setActiveId(null);
  }, [generation]);
  return (
    <>
      {images.map((image) => (
        <Pressable
          key={image.id}
          accessibilityRole="button"
          accessibilityLabel="查看完整图片"
          onPress={() => setActiveId(image.id)}
          style={styles.frame}
        >
          <ImagePixels
            id={image.id}
            pixels={cache.read(image.id)}
            aspectRatio={Math.max(0.5, Math.min(2, image.width / image.height))}
            onRetry={() => cache.retry(image.id)}
          />
        </Pressable>
      ))}
      {activeImage ? (
        <ImagePreview
          aspectRatio={activeImage.width / activeImage.height}
          onClose={() => setActiveId(null)}
          gallery={{
            index,
            count: images.length,
            onChange: (next) => setActiveId(images[next].id),
            renderPage: (page) => (
              <ImagePixels
                key={images[page].id}
                id={images[page].id}
                pixels={cache.read(images[page].id)}
                onRetry={() => cache.retry(images[page].id)}
                fullscreen
              />
            ),
          }}
        >
          <ImagePixels
            key={activeImage.id}
            id={activeImage.id}
            pixels={cache.read(activeImage.id)}
            onRetry={() => cache.retry(activeImage.id)}
            fullscreen
          />
        </ImagePreview>
      ) : null}
    </>
  );
}

export function PrivateAvatar({ url }: { url: string }) {
  const id = url.match(/^\/api\/v1\/media\/([0-9a-f-]{36})$/i)?.[1];
  return id ? <ProtectedPixels id={id} preview aspectRatio={1} /> : null;
}

const createStyles = (C: Colors) => StyleSheet.create({
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

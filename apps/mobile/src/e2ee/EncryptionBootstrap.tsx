import { useEffect } from "react";
import { Alert } from "react-native";
import { router } from "expo-router";
import { encryptionClient, getSessionVersion } from "../api";
import { problemMessage } from "../ui/presentation";

export function EncryptionBootstrap({
  authenticated,
  version,
}: {
  authenticated: boolean;
  version: number;
}) {
  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    void encryptionClient.ensureReady().catch((error) => {
      if (!active || getSessionVersion() !== version) return;
      Alert.alert("加密暂不可用", problemMessage(error), [
        { text: "稍后", style: "cancel" },
        { text: "查看设置", onPress: () => router.push("/encryption") },
      ]);
    });
    return () => {
      active = false;
    };
  }, [authenticated, version]);
  return null;
}

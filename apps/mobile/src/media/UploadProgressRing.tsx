import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { CircleAlert } from "lucide-react-native";

export interface UploadRingProps {
  phase: "queued" | "preparing" | "uploading" | "failed";
  progress: number | null;
}

export function UploadProgressRing({ phase, progress }: UploadRingProps) {
  const amount = progress === null ? null : Math.max(0, Math.min(1, progress));
  const processing = phase === "uploading" && amount === 1;
  const connecting = phase === "uploading" && amount === 0;
  const label =
    phase === "queued"
      ? "等待上传"
      : phase === "preparing"
        ? "准备中"
        : phase === "failed"
          ? "上传失败"
          : processing
            ? "等待确认"
            : connecting
              ? "连接中"
              : "上传中";
  const percent = amount === null ? null : Math.min(99, Math.floor(amount * 100));
  const radius = 21;
  const circumference = 2 * Math.PI * radius;
  return (
    <View
      style={styles.overlay}
      pointerEvents="none"
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={
        phase === "uploading" && percent !== null && !processing && !connecting
          ? { min: 0, max: 100, now: percent }
          : { text: label }
      }
      testID="image-upload-progress"
    >
      <View style={styles.ring}>
        <Svg width={48} height={48} style={styles.svg}>
          <Circle cx={24} cy={24} r={radius} stroke="#FFFFFF50" strokeWidth={3} fill="none" />
          {phase === "uploading" && amount !== null && !processing && !connecting ? (
            <Circle
              cx={24}
              cy={24}
              r={radius}
              stroke="#FFFFFF"
              strokeWidth={3}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={circumference * (1 - amount)}
              rotation={-90}
              origin="24, 24"
            />
          ) : null}
        </Svg>
        {phase === "failed" ? (
          <CircleAlert size={22} color="#FFFFFF" />
        ) : phase === "preparing" ||
          (phase === "uploading" && (amount === null || connecting || processing)) ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.percent}>{phase === "queued" ? "等待" : `${percent}%`}</Text>
        )}
      </View>
      <Text style={styles.caption}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#00000055",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  ring: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  svg: { position: "absolute", top: 0, left: 0 },
  percent: { color: "#FFFFFF", fontSize: 12, fontWeight: "600" },
  caption: { color: "#FFFFFF", fontSize: 11 },
});

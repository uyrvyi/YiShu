import { StyleSheet, Text, View } from "react-native";

/**
 * 驿书 V1 首页占位。
 * Phase 1 仅展示最简骨架内容，不实现任何正式业务 UI。
 */
export default function HomeScreen(): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>驿书</Text>
      <Text style={styles.subtitle}>Phase 1 · 项目骨架</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 24,
    fontWeight: "600",
  },
  subtitle: {
    marginTop: 8,
    fontSize: 14,
    color: "#666",
  },
});

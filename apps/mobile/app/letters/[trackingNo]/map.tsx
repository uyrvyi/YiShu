import { Redirect, useLocalSearchParams } from "expo-router";

export default function LegacyMapRoute() {
  const { trackingNo } = useLocalSearchParams<{ trackingNo: string }>();
  return <Redirect href={`/letters/${trackingNo}/logistics`} />;
}

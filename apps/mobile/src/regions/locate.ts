import * as Location from "expo-location";
import { regionFromAddress, type Region } from "./regions";

export type LocationResult =
  { region: Region; partial: boolean } | { error: "denied" | "unavailable" | "unsupported" };

export async function locateRegion(): Promise<LocationResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return { error: "denied" };
    const work = async (): Promise<LocationResult> => {
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const addresses = await Location.reverseGeocodeAsync(position.coords);
      const region = addresses[0] ? regionFromAddress(addresses[0]) : null;
      return region
        ? { region, partial: !region.city || !region.district }
        : { error: "unsupported" };
    };
    return await Promise.race([
      work(),
      new Promise<LocationResult>((resolve) => {
        timeout = setTimeout(() => resolve({ error: "unavailable" }), 15000);
      }),
    ]);
  } catch {
    return { error: "unavailable" };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

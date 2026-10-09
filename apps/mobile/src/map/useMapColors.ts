import { useAppTheme } from "../ui/ThemeProvider";
import { DARK_MAP_COLORS, MAP_COLORS } from "./theme";

export function useMapColors() {
  return useAppTheme().scheme === "dark" ? DARK_MAP_COLORS : MAP_COLORS;
}

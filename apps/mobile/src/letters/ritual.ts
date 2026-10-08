import type { LetterView } from "../api/letterApi";
import { bodyTextFor } from "../ui/presentation";

export const RITUAL_DURATION = { insert: 900, seal: 900, sealedHold: 1000, reveal: 1400 } as const;

export function readableLetter(letter: LetterView) {
  return letter.status === "DELIVERED" && letter.readState === "OPENED" &&
    !letter.decryptionError && bodyTextFor(letter) !== null;
}

export async function openReadableLetter(
  trackingNo: string,
  api: Pick<import("../api/letterApi").LetterApi, "openLetter" | "getLetter">
) {
  await api.openLetter(trackingNo);
  const letter = await api.getLetter(trackingNo);
  if (!readableLetter(letter)) throw new Error(letter.decryptionError ?? "拆阅已提交，正文暂时无法读取，请重试。");
  return letter;
}

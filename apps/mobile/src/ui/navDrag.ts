export type NavTab = "letters" | "me";

export function navGeometry(width: number) {
  const tabWidth = Math.max(0, (width - 96) / 2);
  return { tabWidth, travel: tabWidth + 80 };
}

export function dragOffset(start: NavTab, dx: number, travel: number) {
  return Math.max(0, Math.min(travel, (start === "me" ? travel : 0) + dx));
}

export function tabAtOffset(offset: number, travel: number): NavTab {
  return offset > travel / 2 ? "me" : "letters";
}

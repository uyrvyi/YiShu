import { describe, expect, it } from "vitest";
import { dragOffset, navGeometry, tabAtOffset } from "./navDrag";

describe("bottom navigation drag geometry", () => {
  it.each([280, 350, 420])(
    "keeps equal tab slots and excludes the compose action at width %s",
    (width) => {
      const { tabWidth, travel } = navGeometry(width);
      expect(tabWidth * 2 + 96).toBe(width);
      expect(travel).toBe(tabWidth + 80);
      expect(dragOffset("letters", -100, travel)).toBe(0);
      expect(dragOffset("me", 100, travel)).toBe(travel);
      expect(tabAtOffset(dragOffset("letters", travel, travel), travel)).toBe("me");
      expect(tabAtOffset(dragOffset("me", -travel, travel), travel)).toBe("letters");
      expect(tabAtOffset(travel / 2, travel)).toBe("letters");
    }
  );
});

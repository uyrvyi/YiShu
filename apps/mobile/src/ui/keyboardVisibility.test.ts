import { describe, expect, it, vi } from "vitest";
import { revealKeyboardInput } from "./keyboardVisibility";

type Measurement = (x: number, y: number, width: number, height: number) => void;
function fixture(top = 100, height = 300, inputTop = 600, inputHeight = 56, offset = 40) {
  const scrollTo = vi.fn();
  const state = {
    scroll: {
      scrollTo,
    },
    viewport: { measureInWindow: (callback: Measurement) => callback(0, top, 390, height) },
    input: {
      measureInWindow: (callback: Measurement) => callback(0, inputTop, 350, inputHeight),
    },
    offset: () => offset,
    isCurrent: () => true,
  };
  return { state, scrollTo };
}
describe("keyboard input visibility", () => {
  it("reveals the bottom edge with an inset and preserves the current offset", () => {
    const { state, scrollTo } = fixture();
    revealKeyboardInput(state);
    expect(scrollTo).toHaveBeenCalledWith({ y: 312, animated: true });
  });
  it("does not scroll a visible input", () => {
    const { state, scrollTo } = fixture(100, 300, 200);
    revealKeyboardInput(state);
    expect(scrollTo).not.toHaveBeenCalled();
  });
  it("reveals an input above the viewport without scrolling past zero", () => {
    const { state, scrollTo } = fixture(100, 300, 80, 56, 10);
    revealKeyboardInput(state);
    expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: true });
  });
  it.each([0, 20, Number.NaN])("ignores invalid viewport height %s", (height) => {
    const { state, scrollTo } = fixture(100, height);
    revealKeyboardInput(state);
    expect(scrollTo).not.toHaveBeenCalled();
  });
  it("ignores invalid input geometry", () => {
    const { state, scrollTo } = fixture(100, 300, Number.NaN);
    revealKeyboardInput(state);
    expect(scrollTo).not.toHaveBeenCalled();
  });
  it("does not scroll after focus changes while native measurement is pending", () => {
    const { state, scrollTo } = fixture();
    let pending: Measurement | undefined;
    let current = true;
    state.input.measureInWindow = (callback) => {
      pending = callback;
    };
    state.isCurrent = () => current;
    revealKeyboardInput(state);
    current = false;
    pending?.(0, 600, 350, 56);
    expect(scrollTo).not.toHaveBeenCalled();
  });
  it("ignores unmounted scroll or input refs", () => {
    const { state, scrollTo } = fixture();
    revealKeyboardInput({ ...state, scroll: null });
    revealKeyboardInput({ ...state, input: null });
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

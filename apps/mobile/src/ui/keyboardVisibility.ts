interface Measurable {
  measureInWindow: (
    callback: (x: number, y: number, width: number, height: number) => void
  ) => void;
}
interface ScrollViewport {
  scrollTo: (options: { y: number; animated: boolean }) => void;
}

/** Measure the actual reduced viewport, not a guessed keyboard height or page offset. */
export function revealKeyboardInput({
  scroll,
  viewport,
  input,
  offset,
  isCurrent,
}: {
  scroll: ScrollViewport | null;
  viewport: Measurable | null;
  input: Measurable | null;
  offset: () => number;
  isCurrent: () => boolean;
}) {
  if (!scroll || !viewport || !input) return;
  viewport.measureInWindow((_x, top, _width, height) => {
    if (!isCurrent() || !Number.isFinite(top) || !Number.isFinite(height) || height <= 32) return;
    input.measureInWindow((_inputX, inputTop, _inputWidth, inputHeight) => {
      if (!isCurrent() || !Number.isFinite(inputTop) || !Number.isFinite(inputHeight)) return;
      const bottom = top + height - 16;
      const delta =
        inputTop < top + 16 ? inputTop - top - 16 : Math.max(0, inputTop + inputHeight - bottom);
      if (Math.abs(delta) > 1)
        scroll.scrollTo({ y: Math.max(0, offset() + delta), animated: true });
    });
  });
}

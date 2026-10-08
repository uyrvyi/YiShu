export const ENVELOPE_GEOMETRY = {
  width: 360,
  height: 240,
  inset: 1,
  radius: 8,
  foldX: 180,
  foldY: 132,
  flapHeight: 132,
  sealSize: 48,
  pocket: "M1 1 L180 132 L359 1 V239 H1 Z",
  bottom: "M1 239 L180 132 L359 239 Z",
  bottomSeam: "M1 239 L180 132 L359 239",
  flap: "M1 1 H359 L180 132 Z",
  flapSeam: "M1 1 L180 132 L359 1",
} as const;

export function envelopeLayout(width: number) {
  const scale = width / ENVELOPE_GEOMETRY.width;
  return {
    width,
    height: ENVELOPE_GEOMETRY.height * scale,
    flapHeight: ENVELOPE_GEOMETRY.flapHeight * scale,
    hingeY: ENVELOPE_GEOMETRY.inset * scale,
    sealLeft: ENVELOPE_GEOMETRY.foldX * scale - ENVELOPE_GEOMETRY.sealSize / 2,
    sealTop: ENVELOPE_GEOMETRY.foldY * scale - ENVELOPE_GEOMETRY.sealSize / 2,
  };
}

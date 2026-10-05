export const PREVIEW_ZOOM = 2.5;
export const MAX_PREVIEW_ZOOM = 5;
export const ORIGINAL_PREVIEW = { zoom: 1, x: 0, y: 0 };
export type PreviewPosition = typeof ORIGINAL_PREVIEW;

export function previewDismissDistance(height: number) {
  return Math.max(80, Math.min(160, height * 0.18));
}

export function previewFrame(width: number, height: number, aspectRatio: number) {
  const ratio = aspectRatio > 0 && Number.isFinite(aspectRatio) ? aspectRatio : 1;
  const fittedWidth = Math.min(width, height * ratio);
  return { width: fittedWidth, height: fittedWidth / ratio };
}

export function constrainPreview(
  position: PreviewPosition,
  width: number,
  height: number,
  aspectRatio: number
): PreviewPosition {
  const zoom = Math.max(1, Math.min(MAX_PREVIEW_ZOOM, position.zoom));
  const frame = previewFrame(width, height, aspectRatio);
  const maxX = Math.max(0, (frame.width * zoom - width) / 2);
  const maxY = Math.max(0, (frame.height * zoom - height) / 2);
  return {
    zoom,
    x: maxX === 0 ? 0 : Math.max(-maxX, Math.min(maxX, position.x)),
    y: maxY === 0 ? 0 : Math.max(-maxY, Math.min(maxY, position.y)),
  };
}

export function pinchPreview(
  position: PreviewPosition,
  initial: { x: number; y: number; distance: number },
  touch: { x: number; y: number; distance: number },
  width: number,
  height: number,
  aspectRatio: number
) {
  const zoom = Math.max(
    1,
    Math.min(
      MAX_PREVIEW_ZOOM,
      position.zoom * (initial.distance > 0 ? touch.distance / initial.distance : 1)
    )
  );
  const ratio = zoom / position.zoom;
  return constrainPreview(
    {
      zoom,
      x: position.x * ratio + touch.x - width / 2 - (initial.x - width / 2) * ratio,
      y: position.y * ratio + touch.y - height / 2 - (initial.y - height / 2) * ratio,
    },
    width,
    height,
    aspectRatio
  );
}

export function zoomPreviewAt(
  x: number,
  y: number,
  width: number,
  height: number,
  aspectRatio: number
) {
  return constrainPreview(
    {
      zoom: PREVIEW_ZOOM,
      x: (width / 2 - x) * (PREVIEW_ZOOM - 1),
      y: (height / 2 - y) * (PREVIEW_ZOOM - 1),
    },
    width,
    height,
    aspectRatio
  );
}

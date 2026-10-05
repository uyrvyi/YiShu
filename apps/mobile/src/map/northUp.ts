export interface NorthUpMap {
  disableRotate?: () => void;
  disableTilt?: () => void;
  setHeading?: (heading: number) => void;
  setTilt?: (tilt: number) => void;
  enableDragging?: () => void;
  enablePinchToZoom?: () => void;
}

// Classic BMap is already north-up; optional camera APIs also cover newer SDKs.
export function lockNorthUp(map: NorthUpMap): void {
  map.disableRotate?.();
  map.disableTilt?.();
  map.setHeading?.(0);
  map.setTilt?.(0);
  map.enableDragging?.();
  map.enablePinchToZoom?.();
}

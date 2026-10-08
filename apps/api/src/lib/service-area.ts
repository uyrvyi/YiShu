import {
  isRegionServiceUnavailable,
  REGION_SERVICE_UNAVAILABLE,
  type ServiceRegion,
} from "@yishu/shared";

export class RegionServiceUnavailableError extends Error {
  readonly statusCode = 422;
  readonly code = REGION_SERVICE_UNAVAILABLE;
  constructor() {
    super(REGION_SERVICE_UNAVAILABLE);
    this.name = "RegionServiceUnavailableError";
  }
}

export function assertServiceRegion(region: ServiceRegion): void {
  if (isRegionServiceUnavailable(region)) throw new RegionServiceUnavailableError();
}

import serviceScope from "./service-scope.json" with { type: "json" };

export const REGION_SERVICE_UNAVAILABLE = "region_service_unavailable";
export const REGION_SERVICE_UNAVAILABLE_MESSAGE = "该地区暂未开通服务，请选择已开通地区。";

export const UNAVAILABLE_PROVINCES = serviceScope.unavailableProvinces;
const unavailableCodes = new Set(
  serviceScope.unavailableDistricts.flatMap((region) => [
    region.code,
    ...(region.legacyCodes ?? []),
  ])
);
const simplifiedCharacters: Record<string, string> = {
  臺: "台",
  灣: "湾",
  門: "门",
  縣: "县",
  別: "别",
  區: "区",
  島: "岛",
};

const aliases = new Set([
  "台湾",
  "台湾省",
  "台灣",
  "台灣省",
  "臺灣",
  "臺灣省",
  "taiwan",
  "tw",
  "香港",
  "香港特别行政区",
  "香港特別行政區",
  "hongkong",
  "hk",
  "澳门",
  "澳门特别行政区",
  "澳門",
  "澳門特别行政区",
  "澳門特別行政區",
  "macao",
  "macau",
  "mo",
  "金门",
  "金门县",
  "金門",
  "金門縣",
  "kinmen",
  "350527",
]);

export interface ServiceRegion {
  province?: string | null;
  city?: string | null;
  district?: string | null;
  code?: string | null;
}

function normalize(value?: string | null): string {
  return (
    value
      ?.normalize("NFKC")
      .replace(/\s+/gu, "")
      .toLowerCase()
      .replace(/[臺灣門縣別區島]/gu, (character) => simplifiedCharacters[character] ?? character) ??
    ""
  );
}

export function isRegionServiceUnavailable(region: ServiceRegion): boolean {
  const blocked = [region.province, region.city, region.district, region.code].some((value) => {
    const normalized = normalize(value);
    return (
      aliases.has(normalized) ||
      unavailableCodes.has(normalized) ||
      UNAVAILABLE_PROVINCES.some(
        (province) =>
          normalized === province.code ||
          (normalized.length === 6 &&
            /^\d{6}$/.test(normalized) &&
            normalized.startsWith(province.code))
      )
    );
  });
  if (blocked) return true;
  // The other Nansha district is in Guangzhou and remains serviceable.
  return serviceScope.unavailableDistricts.some(
    (district) =>
      "province" in district &&
      "city" in district &&
      [district.name, ...(district.legacyNames ?? [])].some(
        (name) => normalize(region.district) === normalize(name)
      ) &&
      (normalize(region.province) === normalize(district.province) ||
        normalize(region.province) === normalize(district.province).replace(/省$/, "") ||
        normalize(region.province) === district.code.slice(0, 2) ||
        normalize(region.province) === district.code.slice(0, 2) + "0000" ||
        normalize(region.city) === normalize(district.city) ||
        normalize(region.city) === normalize(district.city).replace(/市$/, "") ||
        normalize(region.city) === district.code.slice(0, 4) ||
        normalize(region.city) === district.code.slice(0, 4) + "00")
  );
}

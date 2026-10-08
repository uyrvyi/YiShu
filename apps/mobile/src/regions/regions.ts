import data from "./data/pca-current.json";
import { UNAVAILABLE_PROVINCES } from "@yishu/shared";

export interface Region {
  province: string;
  city: string;
  district: string;
}
export interface RegionNode {
  code: string;
  name: string;
  children?: RegionNode[];
}
export const provinces: RegionNode[] = data;
export const provinceOptions: RegionNode[] = [
  ...provinces,
  ...UNAVAILABLE_PROVINCES.filter((region) => !provinces.some((item) => item.code === region.code)),
];
const municipalities = new Set(["11", "12", "31", "50"]);
const normalize = (name: string) =>
  name.trim().replace(/(?:壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市)$/u, "");

export function citiesFor(provinceName: string): RegionNode[] {
  const province = provinces.find((item) => item.name === provinceName);
  if (!province) return [];
  if (municipalities.has(province.code)) {
    return [
      {
        code: province.code,
        name: province.name,
        children: province.children?.flatMap((city) => city.children ?? []),
      },
    ];
  }
  return (province.children ?? []).flatMap((city) =>
    city.name.endsWith("直辖县级行政区划")
      ? (city.children ?? []).map((district) => ({
          code: district.code,
          name: district.name,
          children: [district],
        }))
      : [city]
  );
}

export function districtsFor(region: Pick<Region, "province" | "city">): RegionNode[] {
  return citiesFor(region.province).find((city) => city.name === region.city)?.children ?? [];
}

export function changeRegion(region: Region, level: keyof Region, name: string): Region {
  if (level === "province") return { province: name, city: "", district: "" };
  if (level === "city") return { ...region, city: name, district: "" };
  return { ...region, district: name };
}

export function regionFromAddress(address: {
  region?: string | null;
  city?: string | null;
  district?: string | null;
  subregion?: string | null;
  isoCountryCode?: string | null;
}): Region | null {
  if (address.isoCountryCode && address.isoCountryCode.toUpperCase() !== "CN") return null;
  const province = provinces.find(
    (item) => normalize(item.name) === normalize(address.region ?? "")
  );
  if (!province) return null;
  const cities = citiesFor(province.name);
  const candidates = [address.city, address.subregion, address.district].filter(
    (name): name is string => !!name
  );
  const city = municipalities.has(province.code)
    ? cities[0]
    : cities.find((item) => candidates.some((name) => normalize(item.name) === normalize(name)));
  if (!city) return { province: province.name, city: "", district: "" };
  const district = (city.children ?? []).find((item) => candidates.includes(item.name));
  return { province: province.name, city: city.name, district: district?.name ?? "" };
}

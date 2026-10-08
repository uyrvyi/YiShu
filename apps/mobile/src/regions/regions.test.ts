import { describe, expect, it } from "vitest";
import {
  changeRegion,
  citiesFor,
  districtsFor,
  provinces,
  provinceOptions,
  regionFromAddress,
} from "./regions";

describe("province/city/district selection", () => {
  it("shows unavailable province placeholders without adding serviceable subdivisions", () => {
    expect(provinceOptions).toHaveLength(34);
    for (const name of ["香港特别行政区", "澳门特别行政区", "台湾省"]) {
      expect(provinceOptions.some((province) => province.name === name)).toBe(true);
      expect(citiesFor(name)).toEqual([]);
    }
  });
  it("contains actual offline mainland data, including districts in every municipality", () => {
    expect(provinces).toHaveLength(31);
    for (const province of provinces) {
      const cities = citiesFor(province.name);
      expect(cities.length).toBeGreaterThan(0);
      for (const city of cities)
        expect(districtsFor({ province: province.name, city: city.name }).length).toBeGreaterThan(
          0
        );
    }
    expect(citiesFor("北京市")[0]?.name).toBe("北京市");
    expect(
      districtsFor({ province: "重庆市", city: "重庆市" }).some(
        (district) => district.name === "巫溪县"
      )
    ).toBe(true);
  });
  it("clears dependent selections, rather than keeping districts from a different city", () => {
    const region = { province: "广东省", city: "深圳市", district: "南山区" };
    expect(changeRegion(region, "province", "北京市")).toEqual({
      province: "北京市",
      city: "",
      district: "",
    });
    expect(changeRegion(region, "city", "广州市")).toEqual({
      province: "广东省",
      city: "广州市",
      district: "",
    });
  });
  it("preselects canonical names and does not guess a missing or foreign district", () => {
    expect(
      regionFromAddress({ region: "广东", city: "深圳", district: "南山区", isoCountryCode: "CN" })
    ).toEqual({ province: "广东省", city: "深圳市", district: "南山区" });
    expect(
      regionFromAddress({ region: "上海市", subregion: "上海市", district: "徐汇区" })
    ).toEqual({ province: "上海市", city: "上海市", district: "徐汇区" });
    expect(regionFromAddress({ region: "广东省", city: "深圳市" })?.district).toBe("");
    expect(
      regionFromAddress({ region: "广东省", city: "深圳市", isoCountryCode: "US" })
    ).toBeNull();
    expect(regionFromAddress({ region: "not a province" })).toBeNull();
  });
});

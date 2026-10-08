import { describe, expect, it } from "vitest";
import catalog from "../../../../data/regions/canonical-candidate.json";
import { citiesFor, districtsFor, regionFromAddress, provinces } from "./regions";

describe("active canonical region picker", () => {
  it("exposes exactly the same 2851 region triples as the backend catalog", () => {
    const selected = provinces.flatMap((province) =>
      citiesFor(province.name).flatMap((city) =>
        districtsFor({ province: province.name, city: city.name }).map((district) => ({
          code: district.code,
          province: province.name,
          city: city.name,
          district: district.name,
        }))
      )
    );
    expect(selected).toHaveLength(2851);
    expect(selected).toEqual(catalog.regions.map(({ kind: _kind, ...region }) => region));
    expect(new Set(selected.map((region) => region.code)).size).toBe(2851);
  });

  it("distinguishes municipalities, direct province counties and cities without counties", () => {
    expect(citiesFor("上海市").map((city) => city.name)).toEqual(["上海市"]);
    const shanghai = districtsFor({ province: "上海市", city: "上海市" }).map(
      (region) => region.name
    );
    expect(shanghai).toContain("黄浦区");
    expect(shanghai).toContain("浦东新区");
    expect(citiesFor("新疆维吾尔自治区").map((city) => city.name)).toContain("草湖市");
    expect(districtsFor({ province: "新疆维吾尔自治区", city: "草湖市" })).toEqual([
      { code: "659013", name: "草湖市" },
    ]);
    expect(districtsFor({ province: "广东省", city: "东莞市" })).toEqual([
      { code: "441900", name: "东莞市", kind: "city" },
    ]);
  });

  it("keeps retired saved names unchanged and does not silently locate them in a replacement county", () => {
    const chongqing = districtsFor({ province: "重庆市", city: "重庆市" }).map(
      (region) => region.name
    );
    expect(chongqing).not.toContain("江北区");
    expect(chongqing).not.toContain("渝北区");
    expect(chongqing).toContain("两江新区");
    expect(
      regionFromAddress({
        region: "重庆市",
        city: "重庆市",
        district: "江北区",
        isoCountryCode: "CN",
      })
    ).toEqual({ province: "重庆市", city: "重庆市", district: "" });
  });
});

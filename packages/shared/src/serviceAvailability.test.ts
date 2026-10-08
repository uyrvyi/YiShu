import { describe, expect, it } from "vitest";
import { isRegionServiceUnavailable } from "./serviceAvailability.js";

describe("temporarily unavailable service areas", () => {
  it.each([
    "香港",
    "香港特别行政区",
    "香港特別行政區",
    "香港特別行政区",
    "香港特别行政區",
    "澳门",
    "澳門特別行政區",
    "澳门特別行政区",
    "澳門特别行政区",
    "台湾省",
    "臺灣",
    "臺湾省",
    "台灣省",
    " Hong Kong ",
    "Macao",
    "Taiwan",
    "81",
    "820000",
    "710000",
  ])("rejects province alias %s", (province) => {
    expect(isRegionServiceUnavailable({ province })).toBe(true);
  });
  it.each(["金门县", "金門縣", "金門县", "金门縣", "Kinmen", "350527"])(
    "rejects Kinmen alias %s even under Fujian",
    (district) => {
      expect(isRegionServiceUnavailable({ province: "福建省", city: "泉州市", district })).toBe(
        true
      );
    }
  );
  it("checks numeric selection codes and inconsistent field placement", () => {
    expect(isRegionServiceUnavailable({ code: "350527" })).toBe(true);
    expect(isRegionServiceUnavailable({ province: "广东省", city: "澳门" })).toBe(true);
  });
  it.each([
    { code: "460303" },
    { code: "460322" },
    { province: "海南省", city: "三沙市", district: "南沙区" },
    { province: "海南", district: "南沙區" },
    { province: "46", district: "南沙区" },
    { province: "460000", district: "南沙区" },
    { city: "三沙市", district: "南沙区" },
    { city: "三沙", district: "南沙區" },
    { city: "4603", district: "南沙区" },
    { city: "460300", district: "南沙区" },
    { province: "海南省", city: "三沙市", district: "南沙群岛" },
    { city: "三沙市", district: "南沙群島" },
  ])("rejects only Sansha Nansha with qualifying identity %j", (region) => {
    expect(isRegionServiceUnavailable(region)).toBe(true);
  });
  it.each([
    { province: "广东省", city: "广州市", district: "南沙区", code: "440115" },
    { province: "廣東省", city: "廣州市", district: "南沙區" },
    { province: "海南省", city: "三沙市", district: "西沙区" },
    { province: "海南省", city: "海口市", district: "龙华区" },
    { province: "海南省", city: "三沙市", district: "中沙群岛的岛礁及其海域", code: "460323" },
  ])("does not block Guangzhou Nansha or other Hainan districts %j", (region) => {
    expect(isRegionServiceUnavailable(region)).toBe(false);
  });
  it.each(["海沧区", "南沙区", "浦东新区", "金山区", "香港路", "澳门街"])(
    "does not reject a similarly named mainland location %s",
    (district) => {
      expect(isRegionServiceUnavailable({ province: "福建省", city: "厦门市", district })).toBe(
        false
      );
    }
  );
});

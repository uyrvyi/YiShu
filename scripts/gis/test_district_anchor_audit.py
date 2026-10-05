import unittest

from shapely.geometry import Point, box

from audit_district_anchors import select_district


class DistrictAuditTests(unittest.TestCase):
    def setUp(self):
        self.region = {"code": "990101", "district": "District", "province": "Province",
                       "provinceCode": "99", "city": "City", "cityCode": "9901"}
        self.areas = [self.area(4, "Province", "990000", box(0, 0, 10, 10)),
                      self.area(5, "City", "990100", box(1, 1, 5, 5)),
                      self.area(6, "District", "990101", box(2, 2, 3, 3))]

    @staticmethod
    def area(level, name, code, geometry):
        return {"level": level, "name": name, "code": code, "geometry": geometry,
                "point": geometry.representative_point()}

    def test_exact_code_requires_matching_name_and_both_parents(self):
        self.assertEqual(select_district(self.region, self.areas)[1], "exact_code")
        self.areas[2]["point"] = Point(7, 7)
        self.assertIsNone(select_district(self.region, self.areas)[0])

    def test_stale_code_is_not_repaired_by_name_match(self):
        self.areas[2]["name"] = "Renamed district"
        self.areas.append(self.area(6, "District", "", box(2, 2, 3, 3)))
        self.assertEqual(select_district(self.region, self.areas)[1], "code_name_conflict")

    def test_point_must_be_inside_its_own_district(self):
        self.areas[2]["point"] = Point(4, 4)
        self.assertIsNone(select_district(self.region, self.areas)[0])

    def test_duplicate_uncoded_name_is_not_selected(self):
        self.areas[2]["code"] = ""
        self.areas.append(self.area(6, "District", "", box(3, 3, 4, 4)))
        self.assertIsNone(select_district(self.region, self.areas)[0])

    def test_uncoded_name_requires_verified_city_geometry(self):
        self.areas[2]["code"] = ""
        self.assertEqual(select_district(self.region, self.areas)[1], "name_and_parent_geometry")
        self.areas[1]["code"] = "990200"
        self.assertEqual(select_district(self.region, self.areas)[1], "city_geometry_unavailable")

    def test_municipal_district_uses_province_geometry_for_parent(self):
        self.region.update(provinceCode="31", province="Shanghai", city="Shanghai")
        self.areas[0]["name"] = "Shanghai"
        del self.areas[1]
        self.assertEqual(select_district(self.region, self.areas)[1], "exact_code")


if __name__ == "__main__":
    unittest.main()

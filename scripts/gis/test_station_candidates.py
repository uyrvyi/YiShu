import unittest

from shapely.geometry import box

from station_candidates import audit_stations, city_area, city_regions, verify_candidate_graph
from test_endpoint_release import area


class StationCandidatesTests(unittest.TestCase):
    def setUp(self):
        self.regions = [{"province": "Province", "city": "City", "district": "County", "code": "990101",
                         "provinceCode": "99", "cityCode": "9901", "directProvince": False}]
        self.areas = [area(4, "Province", "990000", box(-180, -90, 180, 90)),
                      area(5, "City", "990100", box(0, 0, 10, 10))]
        self.node = {"id": "city", "province": "Province", "city": "Old alias", "lat": 2, "lng": 3,
                     "mapX": (3 + 180) / 360 * 1000, "mapY": (90 - 2) / 180 * 800}

    def test_only_an_unclaimed_local_station_inside_the_city_can_be_reused(self):
        report = audit_stations(self.regions, self.areas, [self.node], {"cities": {}})
        self.assertEqual(report["summary"]["aliases"], 1)
        self.node["lng"] = 30
        report = audit_stations(self.regions, self.areas, [self.node], {"cities": {}})
        self.assertEqual(report["summary"]["aliases"], 0)
        self.assertEqual(report["summary"]["newStations"], 1)
        self.node.update(lng=3, province="Other Province")
        self.assertEqual(audit_stations(self.regions, self.areas, [self.node], {"cities": {}})["summary"]["aliases"], 0)

    def test_existing_mapping_to_another_province_is_rejected(self):
        self.node["province"] = "Other Province"
        with self.assertRaisesRegex(ValueError, "mapping_invalid"):
            audit_stations(self.regions, self.areas, [self.node], {"cities": {"City": "city"}})

    def test_outside_display_point_is_distinct_from_true_coordinate_and_does_not_change_old_nodes(self):
        self.node["mapX"] = 900
        report = audit_stations(self.regions, self.areas, [self.node], {"cities": {"City": "city"}})
        self.assertTrue(report["records"][0]["existingPointInsideSourceCity"])
        self.assertFalse(report["records"][0]["existingDisplayPointInsideSourceCity"])
        self.assertEqual(self.node["mapX"], 900)

    def test_missing_city_shape_remains_pending_and_direct_county_uses_its_own_shape(self):
        report = audit_stations(self.regions, self.areas[:1], [], {"cities": {}})
        self.assertEqual(report["summary"]["missingGeometries"], 1)
        self.assertIsNone(report["records"][0]["nodeId"])
        self.regions[0].update(city="County", cityCode="9990", code="999001", directProvince=True)
        region = next(iter(city_regions(self.regions).values()))
        county = area(6, "County", "999001")
        self.assertEqual(city_area(region, [self.areas[0], county]), county)

    def test_candidate_graph_requires_true_and_display_points_inside_the_city(self):
        mapping = {"cities": {"City": "city"}}
        result = verify_candidate_graph(self.regions, self.areas, [self.node], mapping)
        self.assertEqual(result["geometry"], "snapshot_pass")
        self.node["mapX"] = 900
        result = verify_candidate_graph(self.regions, self.areas, [self.node], mapping)
        self.assertEqual(result["geometry"], "pending")
        self.assertEqual(result["displayCoordinatesOutsideCity"], ["Province/City"])
        self.assertEqual(verify_candidate_graph([], self.areas, [], mapping)["geometry"], "pending")


if __name__ == "__main__":
    unittest.main()

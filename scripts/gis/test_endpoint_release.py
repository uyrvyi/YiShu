import unittest
from pathlib import Path
from unittest.mock import patch

from shapely.geometry import Point, box

from audit_endpoint_release import (MCA_SHA256, MCA_URL, SOURCE_SHA256,
                                    apply_metadata_corrections, build_report, flatten_regions,
                                    geometry_check, identity_check, official_identities, distinct_endpoint_area,
                                    ROOT, city_graph_input_hashes)


def area(level, name, code, geometry=None, tags=None):
    geometry = geometry if geometry is not None else box(2, 2, 3, 3)
    return {"level": level, "name": name, "code": code, "geometry": geometry,
            "point": geometry.representative_point(), "osmId": "r" + str(level),
            "tags": tags or {}, "pointMethod": "interior_representative_point"}


class EndpointReleaseTests(unittest.TestCase):
    def test_city_graph_provenance_is_identical_for_relative_and_absolute_paths(self):
        names = ("station_nodes.json", "region_station_map.json")
        relative = [Path("data/graphs/china-v3") / name for name in names]
        absolute = [ROOT / path for path in relative]
        contents = [path.read_bytes() for path in absolute]
        with patch("os.getcwd", return_value=str(ROOT)):
            self.assertEqual(city_graph_input_hashes(relative, contents),
                             city_graph_input_hashes(absolute, contents))
        self.assertEqual(set(city_graph_input_hashes(absolute, contents)),
                         {path.as_posix() for path in relative})

    def test_city_graph_provenance_rejects_paths_outside_repository(self):
        with self.assertRaises(ValueError):
            city_graph_input_hashes([ROOT.parent / "station_nodes.json"], [b"[]"])

    def setUp(self):
        self.region = {"code": "990101", "district": "District", "province": "Province",
                       "provinceCode": "99", "city": "City", "cityCode": "9901", "kind": "county"}
        self.areas = [area(4, "Province", "990000", box(0, 0, 10, 10)),
                      area(5, "City", "990100", box(1, 1, 5, 5)),
                      area(6, "District", "990101")]
        self.official = {"990000": "Province", "990100": "City", "990101": "District"}

    def test_official_identity_requires_code_name_and_real_city(self):
        self.assertEqual(identity_check(self.region, self.official), "official_identity_match")
        self.official["990100"] = "Other City"
        self.assertEqual(identity_check(self.region, self.official), "official_city_mismatch")

    def test_source_chinese_name_can_match_when_preferred_name_is_another_language(self):
        self.areas[2].update(name="Other preferred name", tags={"name:zh": "District"})
        self.assertEqual(geometry_check(self.region, self.areas)[1], "exact_code_and_source_name")

    def test_identical_names_do_not_allow_the_wrong_province_or_city_code(self):
        self.region["cityCode"] = "9902"
        self.official["990200"] = "City"
        self.assertEqual(identity_check(self.region, self.official), "official_code_parent_mismatch")
        self.region.update(cityCode="9901", provinceCode="88")
        self.official["880000"] = "Province"
        self.assertEqual(identity_check(self.region, self.official), "official_code_parent_mismatch")

    def test_duplicate_code_is_not_resolved_by_choosing_the_nicer_name(self):
        self.areas.append(area(6, "Wrong district", "990101"))
        self.assertEqual(geometry_check(self.region, self.areas)[1], "code_name_conflict")

    def hub_at(self, point):
        return {"Province/City": {"mapX": (point.x + 180) / 360 * 1000,
                                  "mapY": (90 - point.y) / 180 * 800}}

    def test_coincident_endpoint_uses_same_county_interior_without_changing_source_area(self):
        county = self.areas[2]
        county.update(point=Point(2.1, 2.1), pointMethod="admin_centre")
        original = county["point"]
        selected = distinct_endpoint_area(self.region, county, self.areas, self.hub_at(original))
        self.assertIsNot(selected, county)
        self.assertIs(selected["geometry"], county["geometry"])
        self.assertEqual(selected["osmId"], county["osmId"])
        self.assertTrue(county["geometry"].covers(selected["point"]))
        self.assertFalse(selected["point"].equals(original))
        self.assertIs(county["point"], original)
        self.assertEqual(county["pointMethod"], "admin_centre")
        self.assertEqual(selected["pointMethod"], "district_interior_representative_point_distinct_from_city_hub")

    def test_noncoincident_endpoint_and_legacy_audits_keep_original_point(self):
        county = self.areas[2]
        self.assertIs(distinct_endpoint_area(self.region, county, self.areas, self.hub_at(Point(1.1, 1.1))), county)
        self.assertIs(distinct_endpoint_area(self.region, county, self.areas, None), county)
        self.assertIsNone(distinct_endpoint_area(self.region, None, self.areas, {}))

    def test_does_not_invent_an_offset_when_representative_point_also_coincides(self):
        county = self.areas[2]
        with self.assertRaisesRegex(ValueError, "representative_point_coincident"):
            distinct_endpoint_area(self.region, county, self.areas, self.hub_at(county["point"]))

    def test_representative_point_must_still_belong_to_real_parent_city(self):
        county = self.areas[2]
        county.update(point=Point(2.1, 2.1), pointMethod="admin_centre")
        self.areas[1]["geometry"] = box(1, 1, 2.2, 2.2)
        self.assertIsNotNone(geometry_check(self.region, self.areas)[0])
        with self.assertRaisesRegex(ValueError, "representative_point_parent_check_failed"):
            distinct_endpoint_area(self.region, county, self.areas, self.hub_at(county["point"]))

    def test_missing_local_hub_is_rejected_instead_of_using_a_capital(self):
        with self.assertRaisesRegex(ValueError, "endpoint_city_hub_missing"):
            distinct_endpoint_area(self.region, self.areas[2], self.areas, {})

    def test_report_anchor_and_geometry_evidence_share_the_adjusted_point(self):
        county = self.areas[2]
        county.update(point=Point(2.1, 2.1), pointMethod="admin_centre")
        report, anchors = build_report([], [self.region], self.official, self.areas, [], {},
                                       city_hubs=self.hub_at(county["point"]))
        evidence = report["allSelectedChecks"][0]["sourceEvidence"]
        anchor = anchors["Province/City/District"]
        lng, lat = evidence["point"]
        self.assertEqual(anchor["x"], round((lng + 180) / 360 * 1000, 6))
        self.assertEqual(anchor["y"], round((90 - lat) / 180 * 800, 6))
        self.assertEqual(evidence["pointMethod"], "district_interior_representative_point_distinct_from_city_hub")

    def test_wrong_code_is_not_silently_replaced_by_an_uncoded_shape(self):
        self.areas[2]["name"] = "Obsolete district"
        self.areas.append(area(6, "District", ""))
        self.assertEqual(geometry_check(self.region, self.areas)[1], "code_name_conflict")

    def test_equivalent_semicolon_codes_are_supported_but_conflicting_codes_rejected(self):
        self.areas[0]["code"] = "99;990000"
        self.assertIsNotNone(geometry_check(self.region, self.areas)[0])
        self.areas[0]["code"] = "99;880000"
        self.assertEqual(geometry_check(self.region, self.areas)[1], "province_geometry_unavailable")

    def test_direct_county_does_not_require_a_fictional_city_polygon(self):
        self.region.update(code="999001", city="District", cityCode="9990", directProvince=True)
        self.official["999001"] = self.official.pop("990101")
        self.areas[2]["code"] = "999001"
        self.assertEqual(identity_check(self.region, self.official), "official_identity_match")
        self.areas[2]["level"] = 5
        del self.areas[1]
        self.assertEqual(geometry_check(self.region, self.areas)[1], "exact_code_and_source_name")
        self.areas[1]["point"] = Point(12, 12)
        self.assertIsNone(geometry_check(self.region, self.areas)[0])

    def test_nondistrict_city_is_explicit_not_a_fake_county(self):
        provinces = [{"name": "广东省", "code": "44", "children": [
            {"code": "4419", "name": "东莞市", "children": [
                {"code": "441900", "name": "东莞市", "kind": "city"}]}]}]
        region = flatten_regions(provinces)[0]
        official = {"440000": "广东省", "441900": "东莞市"}
        self.assertEqual(identity_check(region, official), "official_identity_match")
        areas = [area(4, "广东省", "440000", box(0, 0, 10, 10)), area(5, "东莞市", "441900")]
        self.assertIsNotNone(geometry_check(region, areas)[0])
        areas[1]["level"] = 6
        self.assertIsNone(geometry_check(region, areas)[0])

    def test_direct_region_uses_county_name_as_business_city(self):
        regions = flatten_regions([{"name": "河南省", "code": "41", "children": [
            {"name": "省直辖县级行政区划", "code": "4190", "children": [{"name": "济源市", "code": "419001"}]}]}])
        self.assertEqual(regions[0]["city"], "济源市")
        self.assertTrue(regions[0]["directProvince"])

    def test_exclusions_do_not_count_as_geometry_pass_or_release_pass(self):
        original = [{**self.region, "reason": "district_missing_or_ambiguous"}]
        report, anchors = build_report(original, [], {}, [], [], {})
        self.assertEqual(report["summary"]["originalBlocked"], 1)
        self.assertEqual(report["summary"]["dispositions"], {"not_in_official_county_list": 1})
        self.assertEqual(anchors, {})
        self.assertEqual(report["gates"]["release"], "pending")
        self.assertEqual(report["original347"][0]["officialSource"], MCA_URL)

    def test_missing_official_county_prevents_identity_gate_pass(self):
        report, _ = build_report([], [], {"130606": "莲池区"}, [], [], {})
        self.assertEqual(report["summary"]["officialCountiesMissingFromSelection"], ["130606"])
        self.assertEqual(report["gates"]["officialIdentity"], "pending")

    def test_explicit_correction_is_snapshot_bound_and_never_changes_source_geometry(self):
        self.areas[2]["code"] = "old-code"
        manifest = {"version": 1, "snapshotSha256": SOURCE_SHA256, "officialSha256": MCA_SHA256,
                    "metadataOnly": True, "codeCorrections": [["r6", "old-code", "990101", "District"]],
                    "nameCorrections": []}
        corrected = apply_metadata_corrections(self.areas, self.official, manifest)
        self.assertEqual(self.areas[2]["code"], "old-code")
        self.assertEqual(corrected[2]["code"], "990101")
        self.assertIs(corrected[2]["geometry"], self.areas[2]["geometry"])
        self.assertIs(corrected[2]["point"], self.areas[2]["point"])
        self.assertEqual(corrected[2]["metadataCorrection"]["sourceCode"], "old-code")
        manifest["snapshotSha256"] = "changed"
        with self.assertRaisesRegex(ValueError, "provenance"):
            apply_metadata_corrections(self.areas, self.official, manifest)

    def test_correction_rejects_changed_source_name_or_unofficial_target(self):
        manifest = {"version": 1, "snapshotSha256": SOURCE_SHA256, "officialSha256": MCA_SHA256,
                    "metadataOnly": True, "codeCorrections": [["r6", "990101", "990102", "District"]],
                    "nameCorrections": []}
        with self.assertRaisesRegex(ValueError, "official_mismatch"):
            apply_metadata_corrections(self.areas, self.official, manifest)
        manifest["codeCorrections"][0][2] = "990101"
        self.areas[2]["name"] = "Different name"
        with self.assertRaisesRegex(ValueError, "source_mismatch"):
            apply_metadata_corrections(self.areas, self.official, manifest)

    def test_parser_handles_nested_tags_whitespace_and_rejects_duplicates(self):
        codes = ["11", "12", "13", "14", "15", "21", "22", "23", "31", "32", "33", "34", "35", "36", "37", "41", "42", "43", "44", "45", "46", "50", "51", "52", "53", "54", "61", "62", "63", "64", "65"]
        html = "<table>" + "".join(f"<tr><td></td><td>{code}0000</td><td><span>&nbsp;</span>P{code}</td></tr>" for code in codes) + "</table>"
        self.assertEqual(official_identities(html)["310000"], "P31")
        with_note = html + '<tr><td>419001</td><td>济源市*</td></tr><p>直辖县级行政区划汇总码</p>'
        self.assertEqual(official_identities(with_note)["419001"], "济源市")
        with self.assertRaisesRegex(ValueError, "footnote"):
            official_identities(html + '<tr><td>419001</td><td>济源市*</td></tr>')
        with self.assertRaisesRegex(ValueError, "duplicate"):
            official_identities(html + "<tr><td>310000</td><td>Duplicate</td></tr>")


if __name__ == "__main__":
    unittest.main()

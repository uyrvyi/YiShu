import csv
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shapely import to_wkb
from shapely.geometry import LineString, box

from audit_endpoint_release import build_report, write_evidence
from check_endpoint_evidence import check_evidence
from district_snapshot import CACHE_VERSION, SOURCE_SHA256, decode_cache, load_cache
from division_changes import apply_division_changes, text_content
from endpoint_supplements import HANNAN_STREETS, XIONGAN_COUNTIES, supplement_candidates
from test_endpoint_release import area


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        selected = [{"code": "130606", "province": "P", "city": "C", "district": "D"}]
        original = [{"code": f"9{i:05d}", "province": "P", "city": "C", "district": "D", "originalReason": "unverified"}
                    for i in range(347)]
        binding = patch("check_endpoint_evidence.load_expected_inputs", return_value=(selected, original, {}))
        binding.start()
        self.addCleanup(binding.stop)

    def test_cache_rejects_version_source_duplicates_invalid_shape_and_outside_point(self):
        record = {"osmId": "r1", "geometryWkb": to_wkb(box(0, 0, 1, 1), hex=True), "point": [0.5, 0.5]}
        data = {"version": CACHE_VERSION, "sourceSha256": SOURCE_SHA256, "areas": [record],
                "invalidAreas": [], "unassembledRelations": []}
        self.assertEqual(len(decode_cache(data)[0]), 1)
        for key, value in [("version", 999), ("sourceSha256", "different")]:
            with self.assertRaisesRegex(ValueError, "provenance"):
                decode_cache({**data, key: value})
        with self.assertRaisesRegex(ValueError, "duplicate"):
            decode_cache({**data, "areas": [record, record]})
        with self.assertRaisesRegex(ValueError, "geometry"):
            decode_cache({**data, "areas": [{**record, "point": [2, 2]}]})
        with self.assertRaisesRegex(ValueError, "geometry"):
            decode_cache({**data, "areas": [{**record, "geometryWkb": to_wkb(LineString([(0, 0), (1, 1)]), hex=True)}]})
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cache.json"
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "integrity"):
                load_cache(path)

    def test_empty_selection_never_passes_geometry_gate(self):
        report, _ = build_report([], [], {}, [], [], {})
        self.assertEqual(report["gates"]["allSelectedGeometry"], "pending")
        self.assertEqual(report["gates"]["officialIdentity"], "pending")

    def test_original_rows_must_have_unique_identity(self):
        original = {"code": "130606", "district": "莲池区"}
        with self.assertRaisesRegex(ValueError, "coverage"):
            build_report([original, original], [], {}, [], [], {})

    def test_export_is_deterministic_and_tables_have_integrity_hashes(self):
        report, _ = build_report([], [], {}, [], [], {})
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            write_evidence(report, directory, b"report")
            first = (directory / "summary.json").read_bytes()
            write_evidence(report, directory, b"report")
            self.assertEqual(first, (directory / "summary.json").read_bytes())
            summary = json.loads(first)
            for name, digest in summary["tableSha256"].items():
                self.assertEqual(hashlib.sha256((directory / name).read_bytes()).hexdigest(), digest)

    def test_primary_evidence_patch_rejects_transcription_and_integrity_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            files = {"table.html": '<p>2026年6月30日</p><img src="id/images/page.png">',
                     "announcement.html": "<p>设立<span>县</span></p>", "page.png": "primary-image-fixture"}
            for name, content in files.items():
                (directory / name).write_text(content)
            digest = lambda name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
            addition = {"code": "653132", "name": "County", "provinceCode": "65", "cityCode": "6531",
                        "announcementFile": "announcement.html", "announcementSha256": digest("announcement.html"),
                        "requiredAnnouncementText": ["设立县"], "codePageFile": "page.png", "codePageSha256": digest("page.png"),
                        "codePageUrl": "https://example/202607/id/images/page.png",
                        "manualTranscription": {"countyCode": "653132", "countyName": "County"}}
            manifest = {"version": 1, "nationalChangesComplete": False, "codeTableFile": "table.html",
                        "codeTableSha256": digest("table.html"), "additions": [addition]}
            official = {"650000": "Province"}
            updated, _ = apply_division_changes(official, manifest, directory)
            self.assertEqual(updated["653132"], "County")
            self.assertNotIn("653132", official)
            addition["manualTranscription"]["countyCode"] = "653133"
            with self.assertRaisesRegex(ValueError, "transcription"):
                apply_division_changes(official, manifest, directory)
            addition["manualTranscription"]["countyCode"] = "653132"
            (directory / "page.png").write_text("different source")
            with self.assertRaisesRegex(ValueError, "integrity"):
                apply_division_changes(official, manifest, directory)
            self.assertEqual(text_content("<span>2026</span>年"), "2026年")

    def test_portable_evidence_covers_exactly_347_and_rejects_table_changes(self):
        original = [{"code": f"9{i:05d}", "province": "P", "city": "C", "district": "D", "reason": "unverified"}
                    for i in range(347)]
        region = {"code": "130606", "province": "P", "provinceCode": "13", "city": "C", "cityCode": "1306",
                  "district": "D", "kind": "county", "directProvince": False}
        areas = [area(4, "P", "130000", box(0, 0, 10, 10)), area(5, "C", "130600", box(1, 1, 5, 5)), area(6, "D", "130606")]
        report, _ = build_report(original, [region], {"130000": "P", "130600": "C", "130606": "D"}, areas, [], {})
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            write_evidence(report, directory, b"report")
            self.assertEqual(check_evidence(directory)["originalRows"], 347)
            with (directory / "original-347.csv").open("a") as stream:
                stream.write("\n")
            with self.assertRaisesRegex(ValueError, "integrity"):
                check_evidence(directory)

    def release_fixture(self, directory, *, include_geometry=True):
        original = [{"code": f"9{i:05d}", "province": "P", "city": "C", "district": "D", "reason": "unverified"}
                    for i in range(347)]
        region = {"code": "130606", "province": "P", "provinceCode": "13", "city": "C", "cityCode": "1306",
                  "district": "D", "kind": "county", "directProvince": False}
        areas = [area(4, "P", "130000", box(0, 0, 10, 10)), area(5, "C", "130600", box(1, 1, 5, 5))]
        if include_geometry:
            areas.append(area(6, "D", "130606"))
        report, _ = build_report(original, [region], {"130000": "P", "130600": "C", "130606": "D"}, areas, [], {})
        report["gates"].update(currentDivisionChangesThrough20261006="PASS", mapPublicationApproval="PASS", release="PASS")
        write_evidence(report, directory, b"report")
        return json.loads((directory / "summary.json").read_text())

    def test_release_requires_every_prerequisite_not_just_a_summary_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            summary = self.release_fixture(directory)
            self.assertEqual(check_evidence(directory, require_release=True)["release"], "PASS")
            for gate in summary["gates"]:
                with self.subTest(gate=gate):
                    changed = json.loads(json.dumps(summary))
                    changed["gates"][gate] = "pending"
                    (directory / "summary.json").write_text(json.dumps(changed))
                    with self.assertRaisesRegex(ValueError, "release_gate_not_passed"):
                        check_evidence(directory, require_release=True)
            for field in ("officialCountiesMissingFromSelection", "selectedCountiesAbsentFromOfficialList"):
                changed = json.loads(json.dumps(summary))
                changed["summary"][field] = ["130607"]
                (directory / "summary.json").write_text(json.dumps(changed))
                with self.assertRaisesRegex(ValueError, "release_gate_not_passed"):
                    check_evidence(directory, require_release=True)

    def test_summary_pass_cannot_override_a_missing_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            summary = self.release_fixture(directory, include_geometry=False)
            summary["gates"]["allSelectedGeometry"] = "snapshot_pass"
            (directory / "summary.json").write_text(json.dumps(summary))
            self.assertEqual(check_evidence(directory)["pendingCodes"], ["130606"])
            with self.assertRaisesRegex(ValueError, "release_gate_not_passed"):
                check_evidence(directory, require_release=True)

    def test_failure_counts_must_agree_with_individual_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            summary = self.release_fixture(directory)
            summary["summary"]["identityFailures"] = 1
            (directory / "summary.json").write_text(json.dumps(summary))
            with self.assertRaisesRegex(ValueError, "failure_evidence_inconsistent"):
                check_evidence(directory)
            summary["summary"]["identityFailures"] = 0
            summary["summary"]["geometryFailures"] = {"district_missing_or_ambiguous": 1}
            (directory / "summary.json").write_text(json.dumps(summary))
            with self.assertRaisesRegex(ValueError, "failure_evidence_inconsistent"):
                check_evidence(directory)

    def rewrite_selected(self, directory, change):
        path = directory / "selected-regions.csv"
        with path.open(newline="") as stream:
            reader = csv.DictReader(stream)
            fields, rows = reader.fieldnames, list(reader)
        change(rows[0])
        with path.open("w", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
        summary = json.loads((directory / "summary.json").read_text())
        summary["tableSha256"][path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
        (directory / "summary.json").write_text(json.dumps(summary))

    def test_object_id_cannot_turn_a_failed_geometry_verdict_into_release_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            summary = self.release_fixture(directory, include_geometry=False)
            summary["gates"]["allSelectedGeometry"] = "snapshot_pass"
            summary["summary"]["candidateRegions"] = 1
            summary["summary"]["geometryFailures"] = {}
            summary["pendingRegions"] = []
            (directory / "summary.json").write_text(json.dumps(summary))
            self.rewrite_selected(directory, lambda row: row.update(osmId="r123"))
            with self.assertRaisesRegex(ValueError, "geometry_evidence_invalid"):
                check_evidence(directory, require_release=True)

    def test_success_geometry_verdict_requires_valid_coordinate_id_and_point_method(self):
        invalid = [("longitude", ""), ("latitude", "NaN"), ("longitude", "Infinity"),
                   ("longitude", "181"), ("latitude", "-91"), ("osmId", "r0"),
                   ("osmId", "w123"), ("pointMethod", ""), ("geometry", "district_missing_or_ambiguous")]
        for key, value in invalid:
            with self.subTest(field=key, value=value), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                self.release_fixture(directory)
                self.rewrite_selected(directory, lambda row: row.update({key: value}))
                with self.assertRaisesRegex(ValueError, "geometry_evidence_invalid"):
                    check_evidence(directory, require_release=True)
    def supplement_fixture(self):
        province = area(4, "河北省", "130000", box(-10, -10, 100, 100))
        province["osmId"] = "rprovince"
        parent = area(5, "保定市", "1306", box(0, 0, 1, 1))
        parent.update(osmId="r3442995", subareas=[int(rid[1:]) for rid in XIONGAN_COUNTIES])
        areas = [province, parent]
        official = {"371003": "文登区", "420113": "汉南区"}
        for index, (rid, (code, name)) in enumerate(XIONGAN_COUNTIES.items()):
            county = area(6, name, "", box(index + 2, 0, index + 3, 1))
            county["osmId"] = rid
            areas.append(county)
            official[code] = name
        zone = area(6, "武汉经济技术开发区（汉南区）", "420113", box(0, 0, 10, 10))
        zone.update(osmId="r3076294", subareas=list(HANNAN_STREETS))
        areas.append(zone)
        tags = {5652862: {"name": "文登区", "division_code": "371003"}}
        geometries = {5652862: box(0, 0, 1, 1)}
        for index, (rid, (code, name)) in enumerate(HANNAN_STREETS.items()):
            tags[rid] = {"name": name, "division_code": code, "admin_level": "8"}
            geometries[rid] = box(index, 0, index + 1, 1)
        return areas, official, tags, geometries, "原汉南区所辖四个街道；蔡甸区三个街道"

    def test_adapters_do_not_rename_a_whole_functional_zone_or_mutate_original_shapes(self):
        fixture = self.supplement_fixture()
        areas, official, tags, geometries, text = fixture
        source_zone = areas[-1]["geometry"]
        results = {a["osmId"]: a for a in supplement_candidates(*fixture)}
        self.assertEqual(areas[-1]["name"], "武汉经济技术开发区（汉南区）")
        self.assertIs(areas[-1]["geometry"], source_zone)
        self.assertEqual(results["r3076294"]["geometry"].area, 4)
        self.assertEqual(source_zone.area, 100)
        self.assertEqual(results["r3442995"]["geometry"].area, 4)
        self.assertIn("parentGeometryAdapter", results["r4820132"])
        self.assertEqual(results["r5652862"]["level"], 6)

    def test_adapter_rejects_foreign_street_missing_city_membership_or_outside_province(self):
        fixture = self.supplement_fixture()
        fixture[2][17345599]["division_code"] = "420114001"
        with self.assertRaisesRegex(ValueError, "street_identity"):
            supplement_candidates(*fixture)
        fixture = self.supplement_fixture()
        fixture[0][1]["subareas"] = []
        with self.assertRaisesRegex(ValueError, "county_evidence"):
            supplement_candidates(*fixture)
        fixture = self.supplement_fixture()
        fixture[0][2]["geometry"] = box(200, 200, 201, 201)
        with self.assertRaisesRegex(ValueError, "county_evidence"):
            supplement_candidates(*fixture)


if __name__ == "__main__":
    unittest.main()

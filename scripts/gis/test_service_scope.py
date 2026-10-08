import json
import csv
import hashlib
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from audit_endpoint_release import build_report, write_evidence
from check_endpoint_evidence import check_evidence
from service_scope import load_service_scope, unavailable_codes, PREVIOUS_APPROVED_SCOPE
from test_endpoint_release import area
from shapely.geometry import box


class ServiceScopeTests(unittest.TestCase):
    def setUp(self):
        selected = [
            {"code": "130606", "province": "河北省", "city": "保定市", "district": "莲池区"},
            {"code": "350527", "province": "福建省", "city": "泉州市", "district": "金门县"},
        ]
        original = [{"code": f"9{i:05d}", "province": "P", "city": "C", "district": "D", "originalReason": "unverified"}
                    for i in range(347)]
        original[0].update(selected[1])
        binding = patch("check_endpoint_evidence.load_expected_inputs", return_value=(selected, original, {}))
        binding.start()
        self.addCleanup(binding.stop)

    def fixture(self, directory):
        original = [{"code": f"9{i:05d}", "province": "P", "city": "C", "district": "D", "reason": "unverified"}
                    for i in range(347)]
        original[0].update(code="350527", province="福建省", city="泉州市", district="金门县")
        regions = [
            {"code": "130606", "province": "河北省", "provinceCode": "13", "city": "保定市", "cityCode": "1306", "district": "莲池区", "kind": "county"},
            {"code": "350527", "province": "福建省", "provinceCode": "35", "city": "泉州市", "cityCode": "3505", "district": "金门县", "kind": "county"},
        ]
        official = {"130000": "河北省", "130600": "保定市", "130606": "莲池区", "350000": "福建省", "350500": "泉州市", "350527": "金门县"}
        areas = [area(4, "河北省", "130000", box(0, 0, 10, 10)), area(5, "保定市", "130600", box(1, 1, 5, 5)), area(6, "莲池区", "130606")]
        report, anchors = build_report(original, regions, official, areas, [], {}, load_service_scope())
        report["gates"].update(currentDivisionChangesThrough20261006="PASS", mapPublicationApproval="PASS", release="PASS")
        write_evidence(report, directory, b"isolated-fixture-not-release-evidence")
        return report, anchors

    def test_retains_all_original_rows_without_claiming_excluded_geometry_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            report, anchors = self.fixture(directory)
            self.assertEqual(len(report["original347"]), 347)
            self.assertEqual(report["original347"][0]["disposition"], "service_unavailable")
            self.assertEqual(report["allSelectedChecks"][1]["geometry"], "not_required_service_unavailable")
            self.assertIsNone(report["allSelectedChecks"][1]["sourceEvidence"])
            self.assertNotIn("福建省/泉州市/金门县", anchors)
            self.assertEqual(report["gates"]["allSelectedGeometry"], "pending")
            self.assertEqual(report["gates"]["allServiceableGeometry"], "snapshot_pass")
            self.assertEqual(check_evidence(directory, require_release=True)["release"], "PASS")

    def test_only_explicitly_approved_counties_are_excluded(self):
        scope = load_service_scope()
        self.assertEqual(unavailable_codes([{"code": "460303"}, {"code": "350527"}, {"code": "440115"}, {"code": "460302"}], scope), {"350527", "460303"})
        scope["unavailableDistricts"].append({"code": "460302", "name": "西沙区"})
        with self.assertRaisesRegex(ValueError, "service_scope_evidence_invalid"):
            unavailable_codes([], scope)

    def test_previous_approved_scope_remains_verifiable_without_expanding_it(self):
        self.assertEqual(unavailable_codes([{"code": "460303"}, {"code": "350527"}], PREVIOUS_APPROVED_SCOPE), {"350527"})
        changed = json.loads(json.dumps(PREVIOUS_APPROVED_SCOPE))
        changed["unavailableDistricts"].append({"code": "460303", "name": "南沙区"})
        with self.assertRaisesRegex(ValueError, "service_scope_evidence_invalid"):
            unavailable_codes([], changed)

    def test_sansha_is_retained_without_a_fake_anchor_and_guangzhou_is_not_excluded(self):
        original = [{"code": f"9{i:05d}", "province": "P", "city": "C", "district": "D", "reason": "unverified"}
                    for i in range(347)]
        regions = [{"code": "460303", "province": "海南省", "provinceCode": "46", "city": "三沙市", "cityCode": "4603", "district": "南沙区", "kind": "county"},
                   {"code": "440115", "province": "广东省", "provinceCode": "44", "city": "广州市", "cityCode": "4401", "district": "南沙区", "kind": "county"}]
        official = {"460000": "海南省", "460300": "三沙市", "460303": "南沙区", "440000": "广东省", "440100": "广州市", "440115": "南沙区"}
        report, anchors = build_report(original, regions, official, [], [], {}, load_service_scope())
        self.assertEqual(report["allSelectedChecks"][0]["geometry"], "not_required_service_unavailable")
        self.assertIsNone(report["allSelectedChecks"][0]["sourceEvidence"])
        self.assertNotEqual(report["allSelectedChecks"][1]["geometry"], "not_required_service_unavailable")
        self.assertNotIn("海南省/三沙市/南沙区", anchors)

    def test_rejects_missing_or_tampered_scope_and_service_counts(self):
        for field in ("serviceScope", "serviceableRegions", "unavailableRegions"):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                self.fixture(directory)
                path = directory / "summary.json"
                summary = json.loads(path.read_text())
                if field == "serviceScope":
                    summary["provenance"][field]["sha256"] = "0" * 64
                else:
                    summary["summary"][field] += 1
                path.write_text(json.dumps(summary))
                with self.assertRaisesRegex(ValueError, "service_scope"):
                    check_evidence(directory, require_release=True)

    def test_service_geometry_gate_must_pass_independently(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.fixture(directory)
            path = directory / "summary.json"
            summary = json.loads(path.read_text())
            summary["gates"]["allServiceableGeometry"] = "pending"
            path.write_text(json.dumps(summary))
            with self.assertRaisesRegex(ValueError, "release_gate_not_passed"):
                check_evidence(directory, require_release=True)

    def test_original_cannot_claim_success_for_unavailable_kinmen(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.fixture(directory)
            path = directory / "original-347.csv"
            with path.open(newline="") as stream:
                reader = csv.DictReader(stream)
                fields, rows = reader.fieldnames, list(reader)
            rows[0].update(geometry="exact_code_and_source_name", osmId="r123")
            with path.open("w", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=fields)
                writer.writeheader()
                writer.writerows(rows)
            summary_path = directory / "summary.json"
            summary = json.loads(summary_path.read_text())
            summary["tableSha256"][path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
            summary_path.write_text(json.dumps(summary))
            with self.assertRaisesRegex(ValueError, "original_selected_verdict_inconsistent"):
                check_evidence(directory, require_release=True)


class RealSourceBindingTests(unittest.TestCase):
    def test_current_scope_has_no_service_geometry_gap_but_is_not_release_approval(self):
        source = Path(__file__).resolve().parents[2] / "data/maps/audit/endpoint-release-service-scope-20261006-r2"
        result = check_evidence(source)
        self.assertEqual(result["pendingCodes"], [])
        self.assertEqual(result["selectedRows"], 2851)
        with (source / "selected-regions.csv").open(newline="") as stream:
            rows = {row["code"]: row for row in csv.DictReader(stream)}
        for code in ("350527", "460303"):
            self.assertEqual(rows[code]["geometry"], "not_required_service_unavailable")
            self.assertEqual((rows[code]["longitude"], rows[code]["latitude"], rows[code]["osmId"]), ("", "", ""))
        self.assertNotEqual(rows["440115"]["geometry"], "not_required_service_unavailable")
        with self.assertRaisesRegex(ValueError, "release_gate_not_passed"):
            check_evidence(source, require_release=True)

    def test_cannot_drop_sansha_even_after_resigning_tables_and_summary(self):
        source = Path(__file__).resolve().parents[2] / "data/maps/audit/endpoint-release-service-scope-20261006"
        self.assertEqual(check_evidence(source)["pendingCodes"], ["460303"])
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for name in ("selected-regions.csv", "original-347.csv", "summary.json"):
                shutil.copyfile(source / name, directory / name)
            path = directory / "selected-regions.csv"
            with path.open(newline="") as stream:
                reader = csv.DictReader(stream)
                fields, rows = reader.fieldnames, [r for r in reader if r["code"] != "460303"]
            with path.open("w", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=fields)
                writer.writeheader()
                writer.writerows(rows)
            summary_path = directory / "summary.json"
            summary = json.loads(summary_path.read_text())
            summary["summary"]["selectedRegions"] -= 1
            summary["summary"]["serviceableRegions"] -= 1
            summary["summary"]["geometryFailures"] = {}
            summary["pendingRegions"] = []
            summary["tableSha256"][path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
            summary["gates"] = {key: "PASS" for key in summary["gates"]}
            summary_path.write_text(json.dumps(summary))
            for require_release in (False, True):
                with self.subTest(require_release=require_release), self.assertRaisesRegex(ValueError, "source_binding_failed"):
                    check_evidence(directory, require_release=require_release)

    def test_mismatched_source_provenance_is_rejected(self):
        source = Path(__file__).resolve().parents[2] / "data/maps/audit/endpoint-release-service-scope-20261006"
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for name in ("selected-regions.csv", "original-347.csv", "summary.json"):
                shutil.copyfile(source / name, directory / name)
            path = directory / "summary.json"
            summary = json.loads(path.read_text())
            summary["provenance"]["regionsSha256"] = "0" * 64
            path.write_text(json.dumps(summary))
            with self.assertRaisesRegex(ValueError, "provenance_source_binding_failed"):
                check_evidence(directory)


if __name__ == "__main__":
    unittest.main()

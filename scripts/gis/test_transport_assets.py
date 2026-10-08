import copy
import hashlib
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from service_scope import load_service_scope
from verify_transport_assets import ROOT, FROZEN_BASE_SHA256, verify_files, verify_join


class TransportAssetFileTests(unittest.TestCase):
    def verify(self):
        return verify_files(ROOT / "data/maps/audit/endpoint-release-distinct-20261006",
                            ROOT / "data/maps/district-anchors-1.1-candidate.json",
                            ROOT / "data/graphs/china-v3")

    def test_actual_candidate_files_pass_without_changing_runtime_assets(self):
        result = self.verify()
        self.assertEqual(result["summary"]["serviceableRegions"], 2849)
        self.assertFalse(result["runtimeFilesChanged"])

    def test_candidate_manifest_cannot_omit_or_resign_frozen_base(self):
        manifest_path = ROOT / "data/graphs/china-v3/manifest.json"
        base_path = ROOT / "data/graphs/china-v2/station_nodes.json"
        original = Path.read_bytes
        manifest = json.loads(original(manifest_path))
        for attack in ("empty", "omit_nodes", "resign", "extra"):
            candidate = copy.deepcopy(manifest)
            if attack == "empty":
                candidate["baseSha256"] = {}
            elif attack == "omit_nodes":
                del candidate["baseSha256"]["station_nodes.json"]
            elif attack == "resign":
                candidate["baseSha256"]["station_nodes.json"] = hashlib.sha256(b"[]").hexdigest()
            else:
                candidate["baseSha256"]["extra.json"] = "0" * 64

            def read(path):
                if path == manifest_path:
                    return json.dumps(candidate).encode()
                if path == base_path:
                    return b"[]"
                return original(path)

            with self.subTest(attack=attack), patch.object(Path, "read_bytes", read), \
                 self.assertRaisesRegex(ValueError, "frozen_base_manifest_mismatch"):
                self.verify()

    def test_each_frozen_base_file_is_verified_against_fixed_digest(self):
        original = Path.read_bytes
        for name in FROZEN_BASE_SHA256:
            target = ROOT / "data/graphs/china-v2" / name

            def read(path):
                return b"[]" if path == target else original(path)

            with self.subTest(name=name), patch.object(Path, "read_bytes", read), \
                 self.assertRaisesRegex(ValueError, "frozen_base_graph_changed:" + name):
                self.verify()


class TransportAssetJoinTests(unittest.TestCase):
    def setUp(self):
        self.selected = [{"code": "130606", "province": "河北省", "city": "保定市", "district": "莲池区",
                          "osmId": "r123", "longitude": "115.5", "latitude": "38.8"},
                         {"code": "460303", "province": "海南省", "city": "三沙市", "district": "南沙区"}]
        row = self.selected[0]
        self.anchors = {"河北省/保定市/莲池区": {k: row[k] for k in ("code", "province", "city", "district")}}
        self.anchors["河北省/保定市/莲池区"].update(sourceShapeId="r123",
            x=round((115.5 + 180) / 360 * 1000, 6), y=round((90 - 38.8) / 180 * 800, 6))
        self.catalog = {"status": "candidate", "regions": copy.deepcopy(self.selected)}
        self.nodes = [{"id": "baoding", "province": "河北省", "city": "保定市", "lng": 115.4,
                       "lat": 38.9, "mapX": 820.5, "mapY": 227.1},
                      {"id": "sansha", "province": "海南省", "city": "三沙市", "lng": 112.3,
                       "lat": 16.8, "mapX": 812.0, "mapY": 325.3}]
        self.mapping = {"provinceFallback": "reject", "cities": {"保定市": "baoding", "三沙市": "sansha"}}

    def verify(self):
        return verify_join(self.selected, self.anchors, self.catalog, self.nodes, self.mapping, load_service_scope())

    def test_serviceable_endpoints_join_their_own_hub_and_excluded_endpoints_remain_absent(self):
        self.assertEqual(self.verify(), {"selectedRegions": 2, "serviceableRegions": 1,
                         "unavailableCodes": ["460303"], "anchors": 1, "cityHubs": 2,
                         "distinctEndpointRepresentatives": 0,
                         "missingEndpointsOrHubs": 0, "wrongIdentities": 0, "coincidentEndpointHubPairs": 0})

    def test_missing_extra_or_excluded_anchors_are_rejected(self):
        original = copy.deepcopy(self.anchors)
        for replacement in ({}, {**original, "海南省/三沙市/南沙区": {}}, {**original, "河北省/保定市/旧区": {}}):
            with self.subTest(keys=list(replacement)), self.assertRaisesRegex(ValueError, "anchor_coverage"):
                self.anchors = replacement
                self.verify()

    def test_catalog_cannot_drop_duplicate_or_rename_an_endpoint(self):
        for action in (lambda rows: rows.pop(), lambda rows: rows.append(copy.deepcopy(rows[0])),
                       lambda rows: rows[0].update(city="石家庄市")):
            self.catalog["regions"] = copy.deepcopy(self.selected)
            action(self.catalog["regions"])
            with self.assertRaisesRegex(ValueError, "catalog_identity"):
                self.verify()

    def test_anchor_name_code_or_source_object_mismatch_is_rejected(self):
        original = copy.deepcopy(self.anchors)
        for field, value in (("code", "130607"), ("city", "石家庄市"), ("sourceShapeId", "r456")):
            self.anchors = copy.deepcopy(original)
            self.anchors["河北省/保定市/莲池区"][field] = value
            with self.assertRaisesRegex(ValueError, "anchor_identity"):
                self.verify()

    def test_anchor_must_match_projected_source_coordinate_exactly(self):
        self.anchors["河北省/保定市/莲池区"]["x"] += 1
        with self.assertRaisesRegex(ValueError, "anchor_coordinate"):
            self.verify()

    def test_zero_length_timed_district_hub_segment_is_rejected(self):
        anchor = self.anchors["河北省/保定市/莲池区"]
        self.nodes[0].update(mapX=anchor["x"], mapY=anchor["y"])
        with self.assertRaisesRegex(ValueError, "city_hub_coincident"):
            self.verify()

    def test_wrong_city_hub_or_capital_fallback_is_rejected(self):
        self.mapping["cities"]["保定市"] = "sansha"
        with self.assertRaisesRegex(ValueError, "city_hub_identity"):
            self.verify()
        self.mapping["cities"]["保定市"] = "baoding"
        self.mapping["provinceFallback"] = "allow"
        with self.assertRaisesRegex(ValueError, "city_hub_coverage"):
            self.verify()

    def test_nan_hub_and_duplicate_hub_ids_are_rejected(self):
        self.nodes[0]["mapX"] = float("nan")
        with self.assertRaisesRegex(ValueError, "hub_coordinates_invalid"):
            self.verify()
        self.nodes.append(copy.deepcopy(self.nodes[0]))
        with self.assertRaisesRegex(ValueError, "hub_coverage"):
            self.verify()

    def test_boolean_coordinates_are_not_numbers(self):
        self.nodes[0]["lat"] = True
        with self.assertRaisesRegex(ValueError, "hub_coordinates_invalid"):
            self.verify()


if __name__ == "__main__":
    unittest.main()

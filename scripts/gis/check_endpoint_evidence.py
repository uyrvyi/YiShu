"""Check portable audit completeness without confusing an audit with release approval."""

import argparse
import csv
import hashlib
import json
import math
import re
from collections import Counter
from pathlib import Path
from service_scope import unavailable_codes

GEOMETRY_SUCCESS = {"exact_code_and_source_name", "unique_name_and_parent_geometry"}
ROOT = Path(__file__).resolve().parents[2]
CATALOG_SHA256 = "930bd3c5a0171679d246bd8c64ccb7059b4ad0b6f67c28a1dd252345daab2fc9"
ORIGINAL_TABLE_SHA256 = "5323082a9b73831f74bda716ed8b89d6520747818eabec4f246d5dddb992d9c1"
ORIGINAL_AUDIT_SHA256 = "d49e161f5893b3411fd7bea4e290a5ff653f0eee6cd12a988a6763e2fe520481"


def load_expected_inputs():
    catalog = (ROOT / "apps/mobile/src/regions/data/pca-current.json").read_bytes()
    original_path = ROOT / "data/maps/audit/endpoint-release-20261006/original-347.csv"
    if hashlib.sha256(catalog).hexdigest() != CATALOG_SHA256 or \
       hashlib.sha256(original_path.read_bytes()).hexdigest() != ORIGINAL_TABLE_SHA256:
        raise ValueError("audit_bound_source_integrity_failed")
    selected = []
    for province in json.loads(catalog):
        for city in province["children"]:
            for district in city["children"]:
                selected.append({"code": district["code"], "province": province["name"],
                                 "city": province["name"] if province["code"] in {"11", "12", "31", "50"} else
                                 district["name"] if city["name"].endswith("直辖县级行政区划") else city["name"],
                                 "district": district["name"]})
    with original_path.open(newline="", encoding="utf-8") as stream:
        original = list(csv.DictReader(stream))
    return selected, original, {"regionsSha256": CATALOG_SHA256, "originalAuditSha256": ORIGINAL_AUDIT_SHA256}


def check_source_binding(summary, original, selected):
    expected_selected, expected_original, provenance = load_expected_inputs()
    fields = ("code", "province", "city", "district")
    identities = lambda rows, keys: {row["code"]: tuple(row[k] for k in keys) for row in rows}
    if identities(selected, fields) != identities(expected_selected, fields):
        raise ValueError("selected_region_source_binding_failed")
    if identities(original, (*fields, "originalReason")) != identities(expected_original, (*fields, "originalReason")):
        raise ValueError("original_347_source_binding_failed")
    if any(summary["provenance"].get(key) != value for key, value in provenance.items()):
        raise ValueError("audit_provenance_source_binding_failed")


def has_valid_geometry_evidence(row):
    success = row["geometry"] in GEOMETRY_SUCCESS
    if not success:
        if row["osmId"] or row["longitude"] or row["latitude"]:
            raise ValueError("selected_region_geometry_evidence_invalid:" + row["code"])
        return False
    try:
        longitude, latitude = float(row["longitude"]), float(row["latitude"])
    except ValueError as error:
        raise ValueError("selected_region_geometry_evidence_invalid:" + row["code"]) from error
    if not re.fullmatch(r"r[1-9]\d*", row["osmId"]) or not row["pointMethod"] or \
       not math.isfinite(longitude) or not math.isfinite(latitude) or \
       not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
        raise ValueError("selected_region_geometry_evidence_invalid:" + row["code"])
    return True


def check_evidence(directory, *, require_release=False):
    summary = json.loads((directory / "summary.json").read_text())
    tables = {}
    for name in ("original-347.csv", "selected-regions.csv"):
        content = (directory / name).read_bytes()
        if hashlib.sha256(content).hexdigest() != summary["tableSha256"][name]:
            raise ValueError("audit_table_integrity_failed:" + name)
        with (directory / name).open(newline="", encoding="utf-8") as stream:
            tables[name] = list(csv.DictReader(stream))
        if len({row["code"] for row in tables[name]}) != len(tables[name]):
            raise ValueError("audit_table_duplicate_code")
    original, selected = tables["original-347.csv"], tables["selected-regions.csv"]
    if len(original) != 347 or summary["summary"]["originalBlocked"] != 347 or \
       dict(Counter(row["disposition"] for row in original)) != summary["summary"]["dispositions"]:
        raise ValueError("original_347_evidence_incomplete")
    check_source_binding(summary, original, selected)
    geometry_valid = {row["code"]: has_valid_geometry_evidence(row) for row in selected}
    if len(selected) != summary["summary"]["selectedRegions"] or not selected or \
       sum(geometry_valid.values()) != summary["summary"]["candidateRegions"]:
        raise ValueError("selected_region_evidence_incomplete")
    scope = summary["provenance"].get("serviceScope")
    excluded = unavailable_codes(selected, scope)
    if scope is not None:
        if len(excluded) != summary["summary"].get("unavailableRegions") or \
           len(selected) - len(excluded) != summary["summary"].get("serviceableRegions") or \
           excluded != {row["code"] for row in summary.get("unavailableRegions", [])}:
            raise ValueError("service_scope_evidence_incomplete")
        if any((row["disposition"] == "service_unavailable") != (row["code"] in excluded) for row in original):
            raise ValueError("service_scope_original_verdict_invalid")
        if any(row["geometry"] != "not_required_service_unavailable" or geometry_valid[row["code"]]
               for row in selected if row["code"] in excluded) or \
           any(row["geometry"] == "not_required_service_unavailable" for row in selected if row["code"] not in excluded):
            raise ValueError("service_scope_verdict_invalid")
    elif any(row["geometry"] == "not_required_service_unavailable" for row in selected):
        raise ValueError("service_scope_evidence_missing")
    selected_by_code = {row["code"]: row for row in selected}
    for row in original:
        current = selected_by_code.get(row["code"])
        if current is not None:
            disposition = "service_unavailable" if row["code"] in excluded else \
                "geometry_candidate" if geometry_valid[row["code"]] else "geometry_pending"
            if row["disposition"] != disposition or any(row[key] != current[key] for key in ("identity", "geometry", "osmId")):
                raise ValueError("original_selected_verdict_inconsistent:" + row["code"])
        elif any(row[key] for key in ("identity", "geometry", "osmId")):
            raise ValueError("original_unselected_geometry_evidence_invalid:" + row["code"])
    pending = {code for code, valid in geometry_valid.items() if not valid and code not in excluded}
    if pending != {row["code"] for row in summary["pendingRegions"]}:
        raise ValueError("pending_region_evidence_incomplete")
    identity_failures = sum(row["identity"] != "official_identity_match" for row in selected)
    geometry_failures = dict(Counter(row["geometry"] for row in selected if not geometry_valid[row["code"]] and row["code"] not in excluded))
    if identity_failures != summary["summary"]["identityFailures"] or \
       geometry_failures != summary["summary"]["geometryFailures"]:
        raise ValueError("selected_region_failure_evidence_inconsistent")
    if require_release:
        gates = summary["gates"]
        # A summary flag cannot override missing geometry or an unverified prerequisite.
        if gates.get("release") != "PASS" or pending or identity_failures or \
           summary["summary"]["officialCountiesMissingFromSelection"] or \
           summary["summary"]["selectedCountiesAbsentFromOfficialList"] or \
           gates.get("officialIdentity") not in ("baseline_pass", "PASS") or \
           gates.get("allServiceableGeometry" if scope else "allSelectedGeometry") not in ("snapshot_pass", "PASS") or \
           gates.get("currentDivisionChangesThrough20261006") != "PASS" or \
           gates.get("mapPublicationApproval") != "PASS":
            raise ValueError("release_gate_not_passed")
    return {"auditEvidence": "PASS", "originalRows": len(original), "selectedRows": len(selected),
            "pendingCodes": sorted(pending), "release": summary["gates"]["release"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--require-release", action="store_true")
    args = parser.parse_args()
    try:
        result = check_evidence(args.directory, require_release=args.require_release)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    print(json.dumps(result))

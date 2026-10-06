"""Check portable audit completeness without confusing an audit with release approval."""

import argparse
import csv
import hashlib
import json
import math
import re
from collections import Counter
from pathlib import Path

GEOMETRY_SUCCESS = {"exact_code_and_source_name", "unique_name_and_parent_geometry"}


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
    geometry_valid = {row["code"]: has_valid_geometry_evidence(row) for row in selected}
    if len(selected) != summary["summary"]["selectedRegions"] or not selected or \
       sum(geometry_valid.values()) != summary["summary"]["candidateRegions"]:
        raise ValueError("selected_region_evidence_incomplete")
    pending = {code for code, valid in geometry_valid.items() if not valid}
    if pending != {row["code"] for row in summary["pendingRegions"]}:
        raise ValueError("pending_region_evidence_incomplete")
    identity_failures = sum(row["identity"] != "official_identity_match" for row in selected)
    geometry_failures = dict(Counter(row["geometry"] for row in selected if not geometry_valid[row["code"]]))
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
           gates.get("allSelectedGeometry") not in ("snapshot_pass", "PASS") or \
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

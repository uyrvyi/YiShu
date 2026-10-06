"""Compare the candidate catalog with the pinned 2026-06 Fujian official table."""

import argparse
import hashlib
import json
from pathlib import Path
import re

from audit_endpoint_release import TableParser, flatten_regions

SOURCE_URL = "https://mzt.fujian.gov.cn/gk/tzgg/202607/t20260710_7176497.htm"
SOURCE_SHA256 = "577efb4e280099b818ca1418de02d4f98612e1b4aba88c8c030c0596c4c01b74"


def parse_table(html):
    parser = TableParser()
    parser.feed(html)
    identities = {}
    for row in parser.rows:
        codes = [value for value in row if re.fullmatch(r"35\d{4}", value)]
        if not codes:
            continue
        if len(row) != 2 or len(codes) != 1 or row[1] != codes[0] or not row[0]:
            raise ValueError("unexpected_official_table_layout")
        code = codes[0]
        if code in identities:
            raise ValueError("duplicate_official_code")
        identities[code] = row[0]
    if identities.get("350000") != "福建省":
        raise ValueError("official_province_identity_mismatch")
    counties = {code: name for code, name in identities.items() if not code.endswith("00")}
    for code in counties:
        if code[:4] + "00" not in identities:
            raise ValueError("official_city_parent_missing:" + code)
    return identities


def compare_catalog(identities, regions):
    counties = {code: name for code, name in identities.items() if not code.endswith("00")}
    selected = [region for region in regions if region["provinceCode"] == "35"]
    if len({region["code"] for region in selected}) != len(selected):
        raise ValueError("candidate_duplicate_code")
    selected_by_code = {region["code"]: region for region in selected}
    checks = []
    for code in sorted(counties.keys() | selected_by_code.keys()):
        current = selected_by_code.get(code)
        expected = counties.get(code)
        if current is None or expected is None:
            result = "missing_candidate" if current is None else "not_in_official_table"
        elif current["kind"] != "county" or current["district"] != expected or \
                current["province"] != "福建省" or current["cityCode"] != code[:4] or \
                current["city"] != identities[code[:4] + "00"]:
            result = "name_kind_or_parent_mismatch"
        else:
            result = "match"
        checks.append({"code": code, "officialName": expected,
                       "officialCity": identities.get(code[:4] + "00"),
                       "candidate": current, "result": result})
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(".local/regions/fujian-202606-codes.html"))
    parser.add_argument("--regions", type=Path, default=Path("apps/mobile/src/regions/data/pca-current.json"))
    parser.add_argument("--output", type=Path, default=Path("data/maps/audit/fujian-202606-identity.json"))
    args = parser.parse_args()
    content = args.source.read_bytes()
    if hashlib.sha256(content).hexdigest() != SOURCE_SHA256:
        raise ValueError("official_source_sha_mismatch")
    identities = parse_table(content.decode("utf-8"))
    cities = [code for code in identities if code.endswith("00") and code != "350000"]
    if len(identities) != 94 or len(cities) != 9:
        raise ValueError("official_source_count_changed")
    candidate_bytes = args.regions.read_bytes()
    checks = compare_catalog(identities, flatten_regions(json.loads(candidate_bytes)))
    report = {
        "schemaVersion": 1, "inspectedOn": "2026-10-06", "effectiveThrough": "2026-06-30",
        "source": {"url": SOURCE_URL, "sha256": SOURCE_SHA256},
        "candidateSha256": hashlib.sha256(candidate_bytes).hexdigest(),
        "officialCities": len(cities), "officialCounties": 84,
        "matchedCounties": sum(row["result"] == "match" for row in checks),
        "checks": checks,
        "identityComparison": "PASS" if len(checks) == 84 and all(row["result"] == "match" for row in checks) else "FAIL",
        "scope": "Fujian names, codes and city parents through 2026-06-30 only; not geometry, later changes, national completeness or publication approval.",
        "runtimeFilesChanged": False,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "checks"}, ensure_ascii=False, indent=2))
    if report["identityComparison"] != "PASS":
        raise SystemExit("fujian_identity_comparison_failed")


if __name__ == "__main__":
    main()

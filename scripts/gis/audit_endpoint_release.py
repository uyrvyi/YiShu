"""Reconcile every blocked endpoint with official identities and frozen OSM evidence.

Outputs are audit artifacts, not an approved runtime database. A community geometry
match, an official identity, and map publication approval are separate gates.
"""

import argparse
import csv
import hashlib
import json
import re
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

from district_snapshot import SOURCE_SHA256, load_cache, source_digest
from division_changes import apply_division_changes
from endpoint_supplements import SUPPLEMENT_SHA256, apply_supplements

MCA_URL = "https://www.mca.gov.cn/mzsj/xzqh/2025/202401xzqh.html"
MCA_SHA256 = "d4669f6c81091287127147720bad0f3c3465e9e2a2dcc7e887893cc787a23431"
ORIGINAL_AUDIT_SHA256 = "d49e161f5893b3411fd7bea4e290a5ff653f0eee6cd12a988a6763e2fe520481"
MUNICIPALITIES = {"11", "12", "31", "50"}
NO_DISTRICT_CITIES = {"441900", "442000", "460400", "620200"}
CHONGQING_CODES_URL = "https://mzj.cq.gov.cn/zwgk_218/zfxxgkml/tzgg/202512/t20251205_15215632.html"
CHONGQING_BOUNDARY_URL = "https://admin.cq.gov.cn/zwgk/zfxxgkml/szfwj/qtgw/202511/t20251107_15148513.html"
NAME_FIELDS = {"name", "name:zh", "name:zh-Hans", "official_name", "official_name:zh", "official_name:zh-Hans"}


class TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows, self.row, self.cell = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        elif tag in {"td", "th"} and self.row is not None:
            self.cell = []

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in {"td", "th"} and self.cell is not None:
            self.row.append("".join(self.cell).strip())
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None


def official_identities(html):
    parser = TableParser()
    parser.feed(html)
    identities = {}
    for row in parser.rows:
        for index, cell in enumerate(row[:-1]):
            if re.fullmatch(r"\d{6}", cell):
                name = row[index + 1].strip()
                if name.endswith("*"):
                    if cell[2:4] != "90" or "直辖县级行政区划汇总码" not in html:
                        raise ValueError("unsupported_official_name_footnote")
                    name = name[:-1]
                if not name or cell in identities:
                    raise ValueError("official_table_duplicate_or_empty")
                identities[cell] = name
                break
    if sum(code.endswith("0000") and int(code[:2]) <= 65 for code in identities) != 31:
        raise ValueError("official_table_mainland_province_count")
    return identities


def flatten_regions(provinces):
    regions = []
    for province in provinces:
        for city in province.get("children", []):
            direct = city["name"].endswith("直辖县级行政区划")
            for district in city.get("children", []):
                regions.append({"province": province["name"], "provinceCode": province["code"],
                                "city": province["name"] if province["code"] in MUNICIPALITIES
                                else district["name"] if direct else city["name"],
                                "cityCode": city["code"], "district": district["name"],
                                "code": district["code"], "kind": district.get("kind", "county"),
                                "directProvince": direct})
    if len({r["code"] for r in regions}) != len(regions):
        raise ValueError("duplicate_selected_region_code")
    return regions


def names(area):
    return {area["name"], *(v for k, v in area.get("tags", {}).items() if k in NAME_FIELDS)}


def code_matches(area, allowed):
    # OSM permits semicolon-separated references, e.g. Anhui's "34;340000".
    codes = set(area["code"].split(";"))
    return bool(codes) and codes <= allowed


def identity_check(region, official):
    code = region["code"]
    if not re.fullmatch(r"\d{6}", code) or code[:2] != region["provinceCode"] or \
       (region["provinceCode"] not in MUNICIPALITIES and code[:4] != region["cityCode"]):
        return "official_code_parent_mismatch"
    if official.get(code) != region["district"]:
        return "official_code_name_mismatch"
    if official.get(region["provinceCode"] + "0000") != region["province"]:
        return "official_province_mismatch"
    if region["provinceCode"] in MUNICIPALITIES:
        return "official_identity_match"
    if region.get("directProvince"):
        if region["cityCode"] + "00" in official or code in NO_DISTRICT_CITIES:
            return "official_direct_parent_mismatch"
        return "official_identity_match"
    if official.get(region["cityCode"] + "00") != region["city"]:
        return "official_city_mismatch"
    if region.get("kind") == "city" and code not in NO_DISTRICT_CITIES:
        return "unsupported_no_district_city"
    return "official_identity_match"


def geometry_check(region, areas):
    province = [a for a in areas if a["level"] == 4 and region["province"] in names(a)
                and code_matches(a, {region["provinceCode"], region["provinceCode"] + "0000", ""})]
    if len(province) != 1:
        return None, "province_geometry_unavailable"
    if region["provinceCode"] in MUNICIPALITIES or region.get("directProvince"):
        parents = province
    else:
        parents = [a for a in areas if a["level"] == 5 and region["city"] in names(a)
                   and code_matches(a, {region["cityCode"], region["cityCode"] + "00", ""})]
    if len(parents) != 1:
        return None, "city_geometry_unavailable"
    levels = {5} if region.get("kind") == "city" else {5, 6} if region.get("directProvince") else {6}
    allowed_codes = {region["code"], region["code"][:4]} if region.get("kind") == "city" else {region["code"]}
    coded = [a for a in areas if a["level"] in levels and a["code"] and code_matches(a, allowed_codes)]
    if coded and (len(coded) != 1 or region["district"] not in names(coded[0])):
        return None, "code_name_conflict"
    candidates = coded or [a for a in areas if a["level"] in levels and not a["code"]
                          and region["district"] in names(a)]
    matches = [a for a in candidates if a["geometry"].covers(a["point"])
               and province[0]["geometry"].covers(a["point"])
               and parents[0]["geometry"].covers(a["point"])]
    if len(matches) != 1:
        return None, "district_missing_or_ambiguous"
    return matches[0], "exact_code_and_source_name" if coded else "unique_name_and_parent_geometry"


def area_evidence(area):
    return {"osmId": area["osmId"], "code": area["code"], "name": area["name"],
            "sourceNames": sorted(names(area)), "level": area["level"],
            "bounds": list(area["geometry"].bounds), "point": [area["point"].x, area["point"].y],
            "pointMethod": area.get("pointMethod"),
            "metadataCorrection": area.get("metadataCorrection"),
            "geometryAdapter": area.get("geometryAdapter"), "parentGeometryAdapter": area.get("parentGeometryAdapter"),
            "url": "https://www.openstreetmap.org/relation/" + area["osmId"][1:]}


def related_areas(region, areas):
    return [area_evidence(a) for a in areas if a["code"] == region["code"]
            or region["district"] in names(a)]


def apply_metadata_corrections(areas, official, manifest):
    if manifest.get("version") != 1 or manifest.get("snapshotSha256") != SOURCE_SHA256 or \
       manifest.get("officialSha256") != MCA_SHA256 or manifest.get("metadataOnly") is not True:
        raise ValueError("metadata_correction_provenance_failed")
    corrected = {a["osmId"]: dict(a) for a in areas}
    seen = set()
    for rid, old_code, code, name in manifest["codeCorrections"]:
        source = corrected.get(rid)
        if rid in seen or source is None or source["code"] != old_code or name not in names(source):
            raise ValueError("metadata_correction_source_mismatch:" + rid)
        if official.get(code) != name:
            raise ValueError("metadata_correction_official_mismatch:" + rid)
        source.update(code=code, metadataCorrection={"sourceCode": old_code, "officialCode": code,
                                                    "officialName": name, "officialSource": MCA_URL})
        seen.add(rid)
    for rid, code, old_name, name in manifest["nameCorrections"]:
        source = corrected.get(rid)
        if rid in seen or source is None or source["code"] != code or source["name"] != old_name:
            raise ValueError("metadata_correction_source_mismatch:" + rid)
        if official.get(code) != name:
            raise ValueError("metadata_correction_official_mismatch:" + rid)
        source.update(name=name, metadataCorrection={"sourceName": old_name, "officialCode": code,
                                                    "officialName": name, "officialSource": MCA_URL})
        seen.add(rid)
    return list(corrected.values())


def verify_chongqing_patch(directory, official):
    code_bytes = (directory / "chongqing-2025-codes.html").read_bytes()
    boundary_bytes = (directory / "chongqing-2025-boundaries.html").read_bytes()
    code_text, boundary_text = code_bytes.decode(), boundary_bytes.decode()
    if not all(s in code_text for s in ("500157", "500105", "500112", "两江新区", "废止")):
        raise ValueError("chongqing_code_evidence_invalid")
    if not all(s in boundary_text for s in ("两江新区", "北碚区", "大湾镇", "统景镇", "大盛镇", "兴隆镇", "茨竹镇")):
        raise ValueError("chongqing_boundary_evidence_invalid")
    updated = dict(official)
    for code in ("500105", "500112"):
        if updated.pop(code, None) not in {"江北区", "渝北区"}:
            raise ValueError("chongqing_patch_baseline_mismatch")
    updated["500157"] = "两江新区"
    return updated, [{"url": CHONGQING_CODES_URL, "sha256": hashlib.sha256(code_bytes).hexdigest()},
                     {"url": CHONGQING_BOUNDARY_URL, "sha256": hashlib.sha256(boundary_bytes).hexdigest()}]


def build_report(original, regions, official, areas, unassembled, provenance):
    selected = {r["code"]: r for r in regions}
    all_checks, anchors = [], {}
    for region in regions:
        identity = identity_check(region, official)
        area, geometry = geometry_check(region, areas) if identity == "official_identity_match" else (None, "not_checked")
        check = {**region, "identity": identity, "geometry": geometry,
                 "officialSource": provenance.get("officialAdditions", {}).get(region["code"], {}).get("announcementUrl",
                                   CHONGQING_CODES_URL if region["code"] == "500157" else MCA_URL),
                 "officialBaseline": "2026-06-30" if region["code"] in provenance.get("officialAdditions", {}) else "2024-12-31",
                 "sourceEvidence": area_evidence(area) if area else None}
        if area:
            point = area["point"]
            key = "/".join(region[k] for k in ("province", "city", "district"))
            anchors[key] = {k: region[k] for k in ("code", "province", "city", "district")}
            anchors[key].update({"x": round((point.x + 180) / 360 * 1000, 6),
                                "y": round((90 - point.y) / 180 * 800, 6), "sourceShapeId": area["osmId"]})
        else:
            check["relatedAreas"] = related_areas(region, areas)
            check["unassembledRelations"] = [{k: r[k] for k in ("osmId", "name", "code", "level")}
                                              for r in unassembled if r["code"] == region["code"] or region["district"] == r["name"]]
        all_checks.append(check)
    checks_by_code = {c["code"]: c for c in all_checks}
    rows = []
    for region in original:
        current = checks_by_code.get(region["code"])
        if current:
            disposition = "geometry_candidate" if current["sourceEvidence"] else "geometry_pending"
            row = {**region, "disposition": disposition, "current": current}
        else:
            retired = region["code"] in {"500105", "500112"}
            excluded = region["code"] not in official
            row = {**region, "disposition": "retired_official_division" if retired else
                   "not_in_official_county_list" if excluded else "selection_omits_official_division",
                   "officialSource": CHONGQING_CODES_URL if retired else MCA_URL,
                   "officialName": official.get(region["code"]),
                   "relatedAreas": related_areas(region, areas)}
        rows.append(row)
    if len(rows) != len(original) or len({r["code"] for r in rows}) != len(rows):
        raise ValueError("original_audit_coverage_failed")
    official_counties = {code for code in official if int(code[:2]) <= 65 and not code.endswith("00")}
    selected_counties = {r["code"] for r in regions if r["kind"] == "county"}
    missing_official = sorted(official_counties - selected_counties)
    unsupported = sorted(selected_counties - official_counties)
    summary = {"originalBlocked": len(rows), "dispositions": dict(sorted(Counter(r["disposition"] for r in rows).items())),
               "selectedRegions": len(regions), "candidateRegions": len(anchors),
               "identityFailures": sum(c["identity"] != "official_identity_match" for c in all_checks),
               "geometryFailures": dict(sorted(Counter(c["geometry"] for c in all_checks if not c["sourceEvidence"]).items())),
               "officialCountiesMissingFromSelection": missing_official,
               "selectedCountiesAbsentFromOfficialList": unsupported}
    report = {"provenance": provenance, "summary": summary, "original347": rows,
              "allSelectedChecks": all_checks,
              "gates": {"officialIdentity": "pending" if not regions or summary["identityFailures"] or missing_official or unsupported else "baseline_pass",
                        "allSelectedGeometry": "pending" if not regions or len(anchors) != len(regions) else "snapshot_pass",
                        "currentDivisionChangesThrough20261006": "pending",
                        "mapPublicationApproval": "pending", "release": "pending"},
              "runtimeFilesChanged": False}
    return report, anchors


def write_evidence(report, directory, report_bytes):
    directory.mkdir(parents=True, exist_ok=True)
    summary = {k: report[k] for k in ("provenance", "summary", "gates", "runtimeFilesChanged")}
    summary["fullReportSha256"] = hashlib.sha256(report_bytes).hexdigest()
    summary["pendingRegions"] = [c for c in report["allSelectedChecks"] if not c["sourceEvidence"]]
    with (directory / "original-347.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(["code", "province", "city", "district", "originalReason", "disposition", "identity", "geometry", "officialSource", "osmId"])
        for row in report["original347"]:
            current = row.get("current", {})
            writer.writerow([row["code"], row["province"], row["city"], row["district"], row["reason"], row["disposition"],
                             current.get("identity", ""), current.get("geometry", ""),
                             current.get("officialSource", row.get("officialSource", "")),
                             (current.get("sourceEvidence") or {}).get("osmId", "")])
    with (directory / "selected-regions.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(["code", "province", "city", "district", "identity", "geometry", "osmId", "longitude", "latitude", "pointMethod", "geometryAdapter", "parentGeometryAdapter"])
        for check in sorted(report["allSelectedChecks"], key=lambda c: c["code"]):
            source = check["sourceEvidence"] or {}
            writer.writerow([check["code"], check["province"], check["city"], check["district"], check["identity"],
                             check["geometry"], source.get("osmId", ""), *source.get("point", ["", ""]),
                             source.get("pointMethod", ""), json.dumps(source.get("geometryAdapter"), ensure_ascii=False),
                             json.dumps(source.get("parentGeometryAdapter"), ensure_ascii=False)])
    summary["tableSha256"] = {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
                              for name in ("original-347.csv", "selected-regions.csv")}
    (directory / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path(".local/water-source/national-complete.osm.pbf"))
    parser.add_argument("--cache", type=Path, default=Path(".local/maps/district-snapshot-20261003.json"))
    parser.add_argument("--official-directory", type=Path, default=Path(".local/regions"))
    parser.add_argument("--original-audit", type=Path, default=Path(".local/maps/district-audit-20261005/audit.json"))
    parser.add_argument("--regions", type=Path, default=Path("apps/mobile/src/regions/data/pca-current.json"))
    parser.add_argument("--corrections", type=Path, default=Path("data/maps/district-source-corrections.json"))
    parser.add_argument("--changes", type=Path, default=Path("data/maps/division-changes-2026.json"))
    parser.add_argument("--uncorrected", action="store_true")
    parser.add_argument("--supplement", type=Path, default=Path(".local/water-source/endpoint-supplements-20261003.osm.pbf"))
    parser.add_argument("--output", type=Path, default=Path(".local/maps/endpoint-release-audit-20261006"))
    parser.add_argument("--evidence-output", type=Path)
    args = parser.parse_args()
    source_digest(args.source)
    mca = (args.official_directory / "mca-2024.html").read_bytes()
    if hashlib.sha256(mca).hexdigest() != MCA_SHA256:
        raise ValueError("official_table_integrity_failed")
    baseline = official_identities(mca.decode())
    official, patches = verify_chongqing_patch(args.official_directory, baseline)
    changes_bytes = args.changes.read_bytes()
    official, additions = apply_division_changes(official, json.loads(changes_bytes), args.official_directory)
    regions_bytes = args.regions.read_bytes()
    regions = flatten_regions(json.loads(regions_bytes))
    original_bytes = args.original_audit.read_bytes()
    if hashlib.sha256(original_bytes).hexdigest() != ORIGINAL_AUDIT_SHA256:
        raise ValueError("original_audit_digest_failed")
    original = json.loads(original_bytes)
    if original["source"]["sha256"] != SOURCE_SHA256 or len(original["unresolved"]) != 347:
        raise ValueError("original_audit_integrity_failed")
    areas, invalid, unassembled = load_cache(args.cache)
    corrections_bytes = None if args.uncorrected else args.corrections.read_bytes()
    if corrections_bytes is not None:
        areas = apply_metadata_corrections(areas, official, json.loads(corrections_bytes))
        areas = apply_supplements(areas, official, args.supplement, args.official_directory)
    provenance = {"official": {"url": MCA_URL, "sha256": MCA_SHA256, "baseline": "2024-12-31"},
                  "officialPatches": patches, "osmSha256": SOURCE_SHA256,
                  "inventorySha256": hashlib.sha256(args.cache.read_bytes()).hexdigest(),
                  "regionsSha256": hashlib.sha256(regions_bytes).hexdigest(),
                  "originalAuditSha256": hashlib.sha256(original_bytes).hexdigest(),
                  "metadataCorrectionsSha256": hashlib.sha256(corrections_bytes).hexdigest() if corrections_bytes else None,
                  "officialChangesSha256": hashlib.sha256(changes_bytes).hexdigest(), "officialAdditions": additions,
                  "supplementSha256": SUPPLEMENT_SHA256 if corrections_bytes else None,
                  "invalidAreas": invalid, "unassembledRelations": len(unassembled),
                  "limitations": "Official baseline plus evidenced patches; not certification of all 2026 changes, community boundary accuracy or map publication approval."}
    report, anchors = build_report(original["unresolved"], regions, official, areas, unassembled, provenance)
    args.output.mkdir(parents=True, exist_ok=True)
    report_bytes = (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode()
    (args.output / "audit.json").write_bytes(report_bytes)
    (args.output / "candidate-anchors.json").write_text(json.dumps(
        {"source": provenance, "anchors": anchors, "releaseApproval": "pending"}, ensure_ascii=False, separators=(",", ":")) + "\n")
    write_evidence(report, args.output, report_bytes)
    if args.evidence_output:
        write_evidence(report, args.evidence_output, report_bytes)
    print(json.dumps({"summary": report["summary"], "gates": report["gates"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

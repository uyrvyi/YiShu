"""Audit district endpoints against the map snapshot without changing runtime assets."""

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

import osmium
from shapely import from_wkb
from shapely.geometry import Point

SOURCE_SHA256 = "e280d98826f2efb2929703950ea2c294b61940b777cd848fd28f115b3a479b60"
MUNICIPALITIES = {"11", "12", "31", "50"}


def select_district(region, areas):
    coded = [a for a in areas if a["level"] == 6 and a["code"] == region["code"]]
    if coded and (len(coded) != 1 or coded[0]["name"] != region["district"]):
        return None, "code_name_conflict"
    candidates = coded or [
        a for a in areas if a["level"] == 6 and a["name"] == region["district"]
        and not a["code"]
    ]
    province = [a for a in areas if a["level"] == 4 and a["name"] == region["province"]]
    if len(province) != 1:
        return None, "province_geometry_unavailable"
    if region["provinceCode"] in MUNICIPALITIES:
        city = province
    else:
        city = [a for a in areas if a["level"] == 5 and a["name"] == region["city"]
                and a["code"] in {region["cityCode"], region["cityCode"] + "00", ""}]
    if len(city) != 1:
        return None, "city_geometry_unavailable"
    matches = [a for a in candidates if a["geometry"].covers(a["point"])
               and province[0]["geometry"].covers(a["point"])
               and city[0]["geometry"].covers(a["point"])]
    if len(matches) != 1:
        return None, "district_missing_or_ambiguous"
    return matches[0], "exact_code" if coded else "name_and_parent_geometry"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    with args.source.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != SOURCE_SHA256:
        raise ValueError("map_snapshot_integrity_failed")
    regions_path = Path("apps/mobile/src/regions/data/pca-code.json")
    regions_bytes = regions_path.read_bytes()
    provinces = json.loads(regions_bytes)
    legacy = json.loads(Path("data/maps/district-anchors.json").read_text())["anchors"]
    relations, centers = {}, {}

    class Relations(osmium.SimpleHandler):
        def relation(self, obj):
            tags = dict(obj.tags)
            if tags.get("boundary") != "administrative" or tags.get("admin_level") not in {"4", "5", "6"}:
                return
            relations[obj.id] = {
                "name": tags.get("name:zh-Hans", tags.get("name:zh", tags.get("name", ""))),
                "level": int(tags["admin_level"]),
                "code": tags.get("ref:admin:CN", tags.get("division_code", "")),
                "nodes": [m.ref for m in obj.members if m.type == "n" and m.role in {"label", "admin_centre"}],
            }

    Relations().apply_file(str(args.source))
    node_relations = {}
    for rid, relation in relations.items():
        for node in relation["nodes"]:
            node_relations.setdefault(node, []).append(rid)

    class Centers(osmium.SimpleHandler):
        def node(self, obj):
            if obj.id in node_relations and obj.location.valid():
                for rid in node_relations[obj.id]:
                    centers[rid] = Point(obj.location.lon, obj.location.lat)

    Centers().apply_file(str(args.source))
    factory, areas, invalid = osmium.geom.WKBFactory(), [], []
    processor = osmium.FileProcessor(str(args.source)).with_areas().with_filter(
        osmium.filter.EntityFilter(osmium.osm.AREA))
    for obj in processor:
        if obj.from_way() or obj.orig_id() not in relations:
            continue
        rid = obj.orig_id()
        try:
            geometry = from_wkb(factory.create_multipolygon(obj))
            if geometry.is_empty or not geometry.is_valid:
                raise ValueError("invalid_source_geometry")
            point = centers.get(rid)
            if point is None or not geometry.covers(point):
                point = geometry.representative_point()
            areas.append({**relations[rid], "osmId": "r" + str(rid), "geometry": geometry, "point": point})
        except (ValueError, RuntimeError) as error:
            invalid.append({"osmId": "r" + str(rid), "reason": str(error)})
    print(json.dumps({"assembledAreas": len(areas), "invalidAreas": len(invalid)}), flush=True)

    anchors, unresolved, checks = {}, [], []
    summary = Counter()
    province_counts = {}
    for province in provinces:
        counts = Counter()
        for city in province.get("children", []):
            for district in city.get("children", []):
                region = {"province": province["name"], "provinceCode": province["code"],
                          "city": province["name"] if province["code"] in MUNICIPALITIES else city["name"],
                          "cityCode": city["code"], "district": district["name"], "code": district["code"]}
                key = "/".join(region[k] for k in ("province", "city", "district"))
                area, method = select_district(region, areas)
                summary[method] += 1
                counts[method] += 1
                if area is None:
                    unresolved.append({**region, "reason": method})
                    continue
                point = area["point"]
                anchors[key] = {k: region[k] for k in ("code", "province", "city", "district")}
                anchors[key].update({"x": round((point.x + 180) / 360 * 1000, 6),
                                    "y": round((90 - point.y) / 180 * 800, 6), "sourceShapeId": area["osmId"]})
                old = legacy.get(key)
                old_inside = None if old is None else area["geometry"].covers(
                    Point(old["x"] / 1000 * 360 - 180, 90 - old["y"] / 800 * 180))
                checks.append({**region, "osmId": area["osmId"], "method": method,
                               "legacyPointInsideCurrentSource": old_inside})
        province_counts[province["name"]] = dict(counts)
    source = {"provider": "OpenStreetMap", "snapshot": "2026-10-03T20:20:50Z", "sha256": digest,
              "regionsSha256": hashlib.sha256(regions_bytes).hexdigest(), "license": "ODbL-1.0",
              "releaseApproval": "pending", "mapping": "exact code/name or uncoded unique name; province/city geometry containment",
              "limitations": "Geometry checks validate this community snapshot only, not current official divisions or regulatory approval."}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "candidate-anchors.json").write_text(json.dumps(
        {"source": source, "anchors": anchors, "missing": unresolved}, ensure_ascii=False, separators=(",", ":")))
    report = {"source": source, "totalRegions": sum(summary.values()), "candidateRegions": len(anchors),
              "unresolvedRegions": len(unresolved), "summary": dict(summary), "byProvince": province_counts,
              "legacyPointsOutsideCurrentSource": sum(c["legacyPointInsideCurrentSource"] is False for c in checks),
              "checks": checks, "unresolved": unresolved, "invalidAreas": invalid,
              "releaseGate": "pending", "runtimeFilesChanged": False}
    (args.output / "audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({k: report[k] for k in ("totalRegions", "candidateRegions", "unresolvedRegions", "summary",
                                          "legacyPointsOutsideCurrentSource", "releaseGate", "runtimeFilesChanged")}), flush=True)


if __name__ == "__main__":
    main()

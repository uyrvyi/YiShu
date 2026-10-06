"""Audit city-station coverage and emit source-bound candidates for a new graph."""

import argparse
import hashlib
import json
from pathlib import Path

from shapely.geometry import Point

from audit_endpoint_release import (MCA_SHA256, MUNICIPALITIES, apply_metadata_corrections,
                                    area_evidence, code_matches, flatten_regions, names,
                                    official_identities, verify_chongqing_patch)
from district_snapshot import load_cache
from division_changes import apply_division_changes
from endpoint_supplements import apply_supplements


def city_regions(regions):
    cities = {}
    for region in regions:
        key = region["province"] + "/" + region["city"]
        code = region["code"] if region.get("directProvince") else \
            region["provinceCode"] + "0000" if region["provinceCode"] in MUNICIPALITIES else region["cityCode"] + "00"
        if key in cities and cities[key]["stationCode"] != code:
            raise ValueError("business_city_identity_ambiguous")
        cities[key] = {**region, "stationCode": code}
    return cities


def city_area(region, areas):
    direct, municipal = region.get("directProvince"), region["provinceCode"] in MUNICIPALITIES
    levels = {5, 6} if direct else {4} if municipal else {5}
    codes = {region["stationCode"], region["stationCode"][:2] if municipal else region["stationCode"][:4], ""}
    if direct:
        codes = {region["stationCode"], ""}
    candidates = [a for a in areas if a["level"] in levels and region["city"] in names(a)
                  and code_matches(a, codes)]
    provinces = [a for a in areas if a["level"] == 4 and region["province"] in names(a)
                 and code_matches(a, {region["provinceCode"], region["provinceCode"] + "0000", ""})]
    if len(candidates) != 1 or len(provinces) != 1 or not provinces[0]["geometry"].covers(candidates[0]["point"]):
        return None
    return candidates[0]


def audit_stations(regions, areas, nodes, mapping):
    cities = city_regions(regions)
    by_id = {n["id"]: n for n in nodes}
    if len(by_id) != len(nodes):
        raise ValueError("duplicate_station_node")
    owned = {mapping["cities"][r["city"]] for r in cities.values() if r["city"] in mapping["cities"]}
    records = []
    for key, region in sorted(cities.items()):
        area = city_area(region, areas)
        rid = mapping["cities"].get(region["city"])
        node = by_id.get(rid)
        if rid and (node is None or node["province"] != region["province"]):
            raise ValueError("existing_city_mapping_invalid:" + key)
        method = "existing_exact_city" if rid else "missing_city_station"
        # Only reuse a currently unclaimed local station inside this city's polygon.
        if not rid and area:
            local = [n for n in nodes if n["id"] not in owned and n["province"] == region["province"]
                     and area["geometry"].covers(Point(n["lng"], n["lat"]))]
            if len(local) == 1:
                node, rid, method = local[0], local[0]["id"], "existing_local_station_official_name_alias"
                owned.add(rid)
        if not rid and area:
            rid, method = "city-" + region["stationCode"], "new_source_city_station"
        source = area_evidence(area) if area else None
        if source and region.get("directProvince"):
            # A local hub and the county endpoint should not share the same marker.
            # Both points still come from the verified county geometry, not an offset.
            point = area["geometry"].representative_point()
            source["point"] = [point.x, point.y]
            source["pointMethod"] = "county_interior_representative_point_for_local_hub"
        inside = bool(node and area and area["geometry"].covers(Point(node["lng"], node["lat"])))
        display_inside = bool(node and area and area["geometry"].covers(
            Point(node["mapX"] * 360 / 1000 - 180, 90 - node["mapY"] * 180 / 800)))
        records.append({"province": region["province"], "city": region["city"], "code": region["stationCode"],
                        "nodeId": rid, "method": method, "sourceEvidence": source,
                        "existingPointInsideSourceCity": inside if node else None,
                        "existingDisplayPointInsideSourceCity": display_inside if node else None})
    return {"graphBase": "china-v2", "cityCount": len(records), "records": records,
            "summary": {"existingExact": sum(r["method"] == "existing_exact_city" for r in records),
                        "aliases": sum(r["method"] == "existing_local_station_official_name_alias" for r in records),
                        "newStations": sum(r["method"] == "new_source_city_station" for r in records),
                        "missingGeometries": sum(not r["sourceEvidence"] for r in records),
                        "existingPointOutsideSourceCity": sum(r["existingPointInsideSourceCity"] is False for r in records),
                        "existingDisplayPointOutsideSourceCity": sum(r["existingDisplayPointInsideSourceCity"] is False for r in records)},
            "releaseApproval": "pending", "defaultGraphChanged": False}


def verify_candidate_graph(regions, areas, nodes, mapping):
    by_id = {node["id"]: node for node in nodes}
    missing, outside, display_outside = [], [], []
    cities = city_regions(regions)
    for key, region in sorted(cities.items()):
        node = by_id.get(mapping["cities"].get(region["city"]))
        boundary = city_area(region, areas)
        if node is None or boundary is None or node["province"] != region["province"]:
            missing.append(key)
            continue
        if not boundary["geometry"].covers(Point(node["lng"], node["lat"])):
            outside.append(key)
        if not boundary["geometry"].covers(Point(node["mapX"] * 360 / 1000 - 180,
                                                 90 - node["mapY"] * 180 / 800)):
            display_outside.append(key)
    return {"cityCount": len(cities), "missingMappingsOrShapes": missing,
            "sourceCoordinatesOutsideCity": outside, "displayCoordinatesOutsideCity": display_outside,
            "geometry": "pending" if not cities or missing or outside or display_outside else "snapshot_pass",
            "releaseApproval": "pending"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("data/maps/audit/endpoint-release-20261006/city-stations.json"))
    parser.add_argument("--verify-graph", type=Path)
    args = parser.parse_args()
    official_directory = Path(".local/regions")
    mca = (official_directory / "mca-2024.html").read_bytes()
    if hashlib.sha256(mca).hexdigest() != MCA_SHA256:
        raise ValueError("official_table_integrity_failed")
    official, _ = verify_chongqing_patch(official_directory, official_identities(mca.decode()))
    official, _ = apply_division_changes(official, json.loads(Path("data/maps/division-changes-2026.json").read_text()), official_directory)
    areas, _, _ = load_cache(Path(".local/maps/district-snapshot-20261003.json"))
    areas = apply_metadata_corrections(areas, official, json.loads(Path("data/maps/district-source-corrections.json").read_text()))
    areas = apply_supplements(areas, official, Path(".local/water-source/endpoint-supplements-20261003.osm.pbf"), official_directory)
    regions_file = Path("apps/mobile/src/regions/data/pca-current.json")
    nodes_file, map_file = [Path("data/graphs/china-v2") / name for name in ("station_nodes.json", "region_station_map.json")]
    regions = flatten_regions(json.loads(regions_file.read_bytes()))
    if args.verify_graph:
        graph_nodes = args.verify_graph / "station_nodes.json"
        graph_map = args.verify_graph / "region_station_map.json"
        report = verify_candidate_graph(regions, areas, json.loads(graph_nodes.read_bytes()), json.loads(graph_map.read_bytes()))
        report["inputSha256"] = {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                                for path in (regions_file, graph_nodes, graph_map)}
        output = args.verify_graph / "geometry-validation.json"
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(report, ensure_ascii=False))
        return
    report = audit_stations(regions, areas, json.loads(nodes_file.read_bytes()), json.loads(map_file.read_bytes()))
    report["inputSha256"] = {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                            for path in (regions_file, nodes_file, map_file,
                                         Path(".local/maps/district-snapshot-20261003.json"),
                                         Path("data/maps/district-source-corrections.json"),
                                         Path("data/maps/division-changes-2026.json"),
                                         Path(".local/water-source/endpoint-supplements-20261003.osm.pbf"))}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report["summary"]))


if __name__ == "__main__":
    main()

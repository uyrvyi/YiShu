"""Verify a complete candidate selection/endpoint/hub join, never approve release."""

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path

from audit_endpoint_release import flatten_regions
from check_endpoint_evidence import check_evidence
from service_scope import load_service_scope, unavailable_codes

ROOT = Path(__file__).resolve().parents[2]
IDENTITY_FIELDS = ("code", "province", "city", "district")
FROZEN_BASE_SHA256 = {
    "station_nodes.json": "64be6aa1348efebbabeaf6640f6dcde46eadb547416b1c3d592993bbf8041ca3",
    "route_edges.json": "c58306c6a16c893df63288b188b6d88e1ca9cc36278b2efe6f85ab7820bef50c",
    "region_station_map.json": "bb196ce39f18be922333af5d416ddc495d7e57b00fbe44013afebc0a333ec384",
}


def identity(row):
    return tuple(row[field] for field in IDENTITY_FIELDS)


def region_key(row):
    return "/".join(row[field] for field in ("province", "city", "district"))


def verify_join(selected, anchors, catalog, nodes, mapping, scope):
    if catalog["status"] != "candidate":
        raise ValueError("transport_catalog_not_candidate")
    expected = {identity(row) for row in selected}
    if len(expected) != len(selected) or len({row["code"] for row in selected}) != len(selected):
        raise ValueError("transport_selection_duplicate")
    actual = {identity(row) for row in catalog["regions"]}
    if actual != expected or len(actual) != len(catalog["regions"]):
        raise ValueError("transport_catalog_identity_mismatch")
    excluded = unavailable_codes(selected, scope)
    serviceable = [row for row in selected if row["code"] not in excluded]
    if set(anchors) != {region_key(row) for row in serviceable}:
        raise ValueError("transport_anchor_coverage_mismatch")
    by_id = {node["id"]: node for node in nodes}
    cities = {row["city"] for row in selected}
    if len(by_id) != len(nodes) or len(nodes) != len(cities) or \
       set(mapping["cities"]) != cities or mapping.get("provinceFallback") != "reject":
        raise ValueError("transport_city_hub_coverage_mismatch")
    for row in selected:
        node = by_id.get(mapping["cities"][row["city"]])
        if node is None or (node["province"], node["city"]) != (row["province"], row["city"]):
            raise ValueError("transport_city_hub_identity_mismatch:" + row["code"])
        if any(type(node[k]) not in (float, int) or not math.isfinite(node[k])
               for k in ("mapX", "mapY", "lng", "lat")) or \
           not -180 <= node["lng"] <= 180 or not -90 <= node["lat"] <= 90:
            raise ValueError("transport_city_hub_coordinates_invalid:" + row["code"])
        if row["code"] in excluded:
            continue
        anchor = anchors[region_key(row)]
        if identity(anchor) != identity(row) or anchor["sourceShapeId"] != row["osmId"]:
            raise ValueError("transport_anchor_identity_mismatch:" + row["code"])
        longitude, latitude = float(row["longitude"]), float(row["latitude"])
        point = (round((longitude + 180) / 360 * 1000, 6), round((90 - latitude) / 180 * 800, 6))
        if any(type(anchor[k]) not in (float, int) or not math.isfinite(anchor[k])
               for k in ("x", "y")) or (anchor["x"], anchor["y"]) != point:
            raise ValueError("transport_anchor_coordinate_mismatch:" + row["code"])
        if abs(anchor["x"] - node["mapX"]) < 0.000002 and abs(anchor["y"] - node["mapY"]) < 0.000002:
            raise ValueError("transport_anchor_city_hub_coincident:" + row["code"])
    return {"selectedRegions": len(selected), "serviceableRegions": len(serviceable),
            "unavailableCodes": sorted(excluded), "anchors": len(anchors), "cityHubs": len(nodes),
            "distinctEndpointRepresentatives": sum(row.get("pointMethod") == "district_interior_representative_point_distinct_from_city_hub"
                                                     for row in serviceable),
            "missingEndpointsOrHubs": 0, "wrongIdentities": 0, "coincidentEndpointHubPairs": 0}


def verify_files(audit_directory, anchor_path, graph_directory):
    check_evidence(audit_directory)
    inputs = {}

    def read(path):
        content = path.read_bytes()
        inputs[str(path.relative_to(ROOT))] = hashlib.sha256(content).hexdigest()
        return json.loads(content)

    summary = read(audit_directory / "summary.json")
    with (audit_directory / "selected-regions.csv").open(newline="", encoding="utf-8") as stream:
        selected = list(csv.DictReader(stream))
    inputs[str((audit_directory / "selected-regions.csv").relative_to(ROOT))] = summary["tableSha256"]["selected-regions.csv"]
    anchor_document = read(anchor_path)
    if anchor_document["source"] != summary["provenance"] or anchor_document["releaseApproval"] != "pending":
        raise ValueError("transport_anchor_provenance_mismatch")
    scope = load_service_scope()
    if summary["provenance"].get("serviceScope") != scope or \
       summary["gates"].get("allServiceableGeometry") != "snapshot_pass":
        raise ValueError("transport_current_scope_geometry_not_verified")
    selection_path = ROOT / "apps/mobile/src/regions/data/pca-current.json"
    selection = flatten_regions(read(selection_path))
    catalog = read(ROOT / "data/regions/canonical-candidate.json")
    if catalog["selectionSha256"] != inputs[str(selection_path.relative_to(ROOT))] or \
       catalog["selectionSha256"] != summary["provenance"]["regionsSha256"] or \
       [tuple(row[k] for k in (*IDENTITY_FIELDS, "kind")) for row in catalog["regions"]] != \
       [tuple(row[k] for k in (*IDENTITY_FIELDS, "kind")) for row in selection]:
        raise ValueError("transport_selection_catalog_provenance_mismatch")
    nodes_path, mapping_path = [graph_directory / name for name in ("station_nodes.json", "region_station_map.json")]
    nodes, mapping = read(nodes_path), read(mapping_path)
    manifest = read(graph_directory / "manifest.json")
    if manifest.get("version") != "china-v3" or manifest.get("status") != "candidate" or \
       manifest.get("releaseApproval") != "pending" or manifest.get("registered") is not False:
        raise ValueError("transport_graph_not_candidate")
    graph_hashes = {str(path.relative_to(ROOT)): inputs[str(path.relative_to(ROOT))] for path in (nodes_path, mapping_path)}
    if graph_hashes != summary["provenance"].get("cityGraphInputSha256") or \
       any(manifest["outputSha256"][path.name] != digest for path, digest in
           ((nodes_path, graph_hashes[str(nodes_path.relative_to(ROOT))]),
            (mapping_path, graph_hashes[str(mapping_path.relative_to(ROOT))]))):
        raise ValueError("transport_graph_provenance_mismatch")
    edge_path = graph_directory / "route_edges.json"
    read(edge_path)
    if inputs[str(edge_path.relative_to(ROOT))] != manifest["outputSha256"][edge_path.name]:
        raise ValueError("transport_graph_edge_integrity_failed")
    if manifest.get("baseSha256") != FROZEN_BASE_SHA256:
        raise ValueError("transport_frozen_base_manifest_mismatch")
    for name, digest in FROZEN_BASE_SHA256.items():
        path = ROOT / "data/graphs/china-v2" / name
        read(path)
        if inputs[str(path.relative_to(ROOT))] != digest:
            raise ValueError("transport_frozen_base_graph_changed:" + name)
    registry = read(ROOT / "data/graphs/registry.json")
    if registry != {"versions": ["china-v1", "china-v2"], "defaultVersion": "china-v2"}:
        raise ValueError("transport_production_graph_already_changed")
    read(ROOT / "packages/shared/src/service-scope.json")
    for relative, digest in {
        "data/maps/district-anchors.json": "3a17cf5a08bf4f7e50f57e8d1c88dc7729060741ef1b2ada39ba2eb88cb041ad",
        "apps/mobile/src/regions/data/pca-code.json": "83b7536f853ad16beb4d37b92890a3fd7bb9d33d4f37e7c8885fb948749a9bc4",
    }.items():
        read(ROOT / relative)
        if inputs[relative] != digest:
            raise ValueError("transport_runtime_asset_already_changed:" + relative)
    result = verify_join(selected, anchor_document["anchors"], catalog, nodes, mapping, scope)
    return {"status": "candidate", "verification": "selection_endpoint_city_hub_join_pass",
            "summary": result, "inputSha256": inputs, "serviceScope": scope["revision"],
            "releaseApproval": "pending", "releaseGates": summary["gates"],
            "runtimeFilesChanged": False,
            "limitations": "Snapshot data join only; not transport execution, official boundary certification, map approval, server deployment or device acceptance."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-directory", type=Path, default=ROOT / "data/maps/audit/endpoint-release-distinct-20261006")
    parser.add_argument("--anchors", type=Path, default=ROOT / "data/maps/district-anchors-1.1-candidate.json")
    parser.add_argument("--graph", type=Path, default=ROOT / "data/graphs/china-v3")
    parser.add_argument("--output", type=Path, default=ROOT / "data/maps/audit/transport-1.1-candidate-20261006.json")
    args = parser.parse_args()
    report = verify_files(args.audit_directory.resolve(), args.anchors.resolve(), args.graph.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"verification": report["verification"], **report["summary"], "releaseApproval": "pending"}, ensure_ascii=False))

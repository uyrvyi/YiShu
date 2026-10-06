"""Extract reproducible administrative evidence; never replace runtime map assets."""

import argparse
import hashlib
import json
from pathlib import Path

import osmium
from shapely import from_wkb, to_wkb
from shapely.geometry import Point

SOURCE_SHA256 = "e280d98826f2efb2929703950ea2c294b61940b777cd848fd28f115b3a479b60"
CACHE_VERSION = 1
CACHE_SHA256 = "3a02a5e2aab404103993e4ac73ae7126bb73d346b55693723e1b2f5206d83156"


def source_digest(source):
    with source.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != SOURCE_SHA256:
        raise ValueError("map_snapshot_integrity_failed")
    return digest


def extract_areas(source):
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
                "tags": tags,
                "nodes": [{"ref": m.ref, "role": m.role} for m in obj.members
                          if m.type == "n" and m.role in {"label", "admin_centre"}],
                "subareas": [m.ref for m in obj.members if m.type == "r" and m.role == "subarea"],
            }

    Relations().apply_file(str(source))
    node_relations = {}
    for rid, relation in relations.items():
        for node in relation["nodes"]:
            node_relations.setdefault(node["ref"], []).append((rid, node["role"]))

    class Centers(osmium.SimpleHandler):
        def node(self, obj):
            if obj.id in node_relations and obj.location.valid():
                for rid, role in node_relations[obj.id]:
                    centers.setdefault(rid, []).append({"role": role, "nodeId": obj.id,
                                                       "point": Point(obj.location.lon, obj.location.lat)})

    Centers().apply_file(str(source))
    factory, areas, invalid = osmium.geom.WKBFactory(), [], []
    assembled = set()
    processor = osmium.FileProcessor(str(source)).with_areas().with_filter(
        osmium.filter.EntityFilter(osmium.osm.AREA))
    for obj in processor:
        if obj.from_way() or obj.orig_id() not in relations:
            continue
        rid = obj.orig_id()
        assembled.add(rid)
        try:
            geometry = from_wkb(factory.create_multipolygon(obj))
            if geometry.is_empty or not geometry.is_valid:
                raise ValueError("invalid_source_geometry")
            candidates = [c for c in centers.get(rid, []) if geometry.covers(c["point"])]
            candidates.sort(key=lambda c: (c["role"] != "admin_centre", c["nodeId"]))
            point = candidates[0]["point"] if candidates else geometry.representative_point()
            areas.append({**relations[rid], "osmId": "r" + str(rid), "geometry": geometry,
                          "point": point, "pointMethod": candidates[0]["role"] if candidates else "interior_representative_point"})
        except (ValueError, RuntimeError) as error:
            invalid.append({"osmId": "r" + str(rid), "reason": str(error)})
    missing = [{**relation, "osmId": "r" + str(rid), "reason": "unassembled_relation"}
               for rid, relation in sorted(relations.items()) if rid not in assembled]
    return sorted(areas, key=lambda a: a["osmId"]), invalid, missing


def save_cache(output, areas, invalid, missing):
    records = [{**{k: v for k, v in area.items() if k not in {"geometry", "point"}},
                "geometryWkb": to_wkb(area["geometry"], hex=True),
                "point": [area["point"].x, area["point"].y]} for area in areas]
    data = {"version": CACHE_VERSION, "sourceSha256": SOURCE_SHA256,
            "areas": records, "invalidAreas": invalid, "unassembledRelations": missing}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")


def decode_cache(data):
    if data.get("version") != CACHE_VERSION or data.get("sourceSha256") != SOURCE_SHA256:
        raise ValueError("snapshot_cache_provenance_failed")
    areas = [{**area, "geometry": from_wkb(area["geometryWkb"]), "point": Point(area["point"])}
             for area in data["areas"]]
    if len({a["osmId"] for a in areas}) != len(areas):
        raise ValueError("duplicate_snapshot_relation")
    if any(a["geometry"].is_empty or not a["geometry"].is_valid or
           a["geometry"].geom_type not in {"Polygon", "MultiPolygon"} or
           not a["geometry"].covers(a["point"]) for a in areas):
        raise ValueError("invalid_cached_geometry")
    return areas, data["invalidAreas"], data["unassembledRelations"]


def load_cache(path):
    content = path.read_bytes()
    if hashlib.sha256(content).hexdigest() != CACHE_SHA256:
        raise ValueError("snapshot_cache_integrity_failed")
    return decode_cache(json.loads(content))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    source_digest(args.source)
    areas, invalid, missing = extract_areas(args.source)
    save_cache(args.output, areas, invalid, missing)
    print(json.dumps({"assembledAreas": len(areas), "invalidAreas": len(invalid),
                      "unassembledRelations": len(missing), "cache": str(args.output)}), flush=True)

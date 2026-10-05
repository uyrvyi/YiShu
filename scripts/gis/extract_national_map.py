"""Extract shared OSM boundaries and water surfaces; never snap or infer banks."""

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

import osmium
from pyproj import Geod
from shapely import from_wkb
from shapely.geometry import Point, mapping

source, target = map(Path, sys.argv[1:3])
target.mkdir(parents=True, exist_ok=True)
relations, boundary_ways, label_nodes = {}, {}, {}
counts, errors, labels = Counter(), [], []
geod, factory = Geod(ellps="WGS84"), osmium.geom.WKBFactory()


class Relations(osmium.SimpleHandler):
    def relation(self, obj):
        tags = dict(obj.tags)
        macau = tags.get("ISO3166-1") == "MO" and tags.get("admin_level") == "3"
        if tags.get("boundary") != "administrative" or (tags.get("admin_level") not in {"4", "5", "6"} and not macau):
            return
        level = 4 if macau else int(tags["admin_level"])
        relations[obj.id] = {"name": tags.get("name:zh-Hans", tags.get("name:zh", tags.get("name", ""))), "level": level,
                             "code": tags.get("ref:admin:CN", tags.get("division_code", ""))}
        for member in obj.members:
            if member.type == "w" and member.role in {"", "outer", "inner"}:
                boundary_ways[member.ref] = min(level, boundary_ways.get(member.ref, level))
            if member.type == "n" and member.role in {"label", "admin_centre"}:
                label_nodes.setdefault(member.ref, []).append(obj.id)


Relations().apply_file(str(source))
centers = {}


class Centers(osmium.SimpleHandler):
    def node(self, obj):
        if obj.id in label_nodes and obj.location.valid():
            for rid in label_nodes[obj.id]:
                centers[rid] = [obj.location.lon, obj.location.lat]


Centers().apply_file(str(source))
seen, admin_geometries = set(), {}
output = target / "national.geojsonseq"
with output.open("w") as stream:
    def emit(oid, geometry, layer, minzoom, properties):
        if (layer, oid) in seen:
            return
        seen.add((layer, oid))
        feature = {"type": "Feature", "properties": {"osmId": oid, **properties},
                   "tippecanoe": {"layer": layer, "minzoom": minzoom}, "geometry": mapping(geometry)}
        stream.write(json.dumps(feature, ensure_ascii=False, separators=(",", ":")) + "\n")
        counts[layer] += 1

    processor = osmium.FileProcessor(str(source)).with_areas().with_filter(
        osmium.filter.EntityFilter(osmium.osm.WAY | osmium.osm.AREA))
    for obj in processor:
        tags = dict(obj.tags)
        try:
            if obj.is_way():
                level = boundary_ways.get(obj.id)
                coast = tags.get("natural") == "coastline"
                if level is None and not coast:
                    continue
                geometry = from_wkb(factory.create_linestring(obj))
                if geometry.is_empty or not geometry.is_valid:
                    raise ValueError("invalid source line")
                if level is not None:
                    if tags.get("maritime") == "yes":
                        counts["maritimeSkipped"] += 1
                    else:
                        emit("w" + str(obj.id), geometry, "boundary", {4: 2, 5: 6, 6: 9}[level], {"level": level})
                if coast:
                    emit("w" + str(obj.id), geometry, "coastline", 5, {})
            elif obj.is_area():
                water = tags.get("natural") == "water" or tags.get("waterway") == "riverbank"
                rid = obj.orig_id() if not obj.from_way() else None
                if not water and rid not in relations:
                    continue
                geometry = from_wkb(factory.create_multipolygon(obj))
                if geometry.is_empty or not geometry.is_valid:
                    raise ValueError("invalid source area")
                oid = ("w" if obj.from_way() else "r") + str(obj.orig_id())
                if rid in relations:
                    prop = relations[rid]
                    center = centers.get(rid)
                    if not center or not geometry.covers(Point(center)):
                        center = list(geometry.representative_point().coords[0])
                    labels.append({**prop, "osmId": oid, "center": center,
                                   "minzoom": {4: 3, 5: 7, 6: 10}[prop["level"]]})
                    counts["admin" + str(prop["level"])] += 1
                    # Retain only public Shanghai geometry for alignment regression.
                    if prop["name"] in {"黄浦区", "浦东新区", "徐汇区", "虹口区", "杨浦区"}:
                        admin_geometries[oid] = {"type": "Feature", "properties": prop, "geometry": mapping(geometry)}
                if water:
                    area = sum(abs(geod.geometry_area_perimeter(poly)[0]) for poly in geometry.geoms)
                    if area < 5000:
                        counts["smallWaterSkipped"] += 1
                        continue
                    minimum = 5 if area >= 2000000 else 8 if area >= 250000 else 10 if area >= 20000 else 12
                    emit(oid, geometry, "water", minimum, {"areaM2": round(area), "name": tags.get("name:zh", tags.get("name", ""))})
        except (RuntimeError, ValueError) as error:
            errors.append({"id": obj.id, "reason": str(error)})

labels.sort(key=lambda p: (p["level"], p["osmId"]))
assembled = {p["osmId"] for p in labels}
missing_areas = [{**prop, "osmId": "r" + str(rid)} for rid, prop in relations.items() if "r" + str(rid) not in assembled]
for rid, prop in relations.items():
    if "r" + str(rid) not in assembled and rid in centers:
        labels.append({**prop, "osmId": "r" + str(rid), "center": centers[rid],
                       "minzoom": {4: 3, 5: 7, 6: 10}[prop["level"]], "labelOnly": True})
(target / "labels.json").write_text(json.dumps(labels, ensure_ascii=False, separators=(",", ":")))
(target / "shanghai-admin.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": list(admin_geometries.values())}, ensure_ascii=False))
report = {"snapshot": "2026-10-03T20:20:50Z", "source": "Geofabrik China and Taiwan / OpenStreetMap",
          "filteredSha256": hashlib.file_digest(source.open("rb"), "sha256").hexdigest(),
          "sourceFeatureCounts": dict(counts), "relations": len(relations), "errors": errors,
          "unassembledAdministrativeAreas": missing_areas,
          "license": "ODbL-1.0", "attribution": "© OpenStreetMap contributors",
          "limitations": "Community mapping coverage, not an official administrative/legal boundary certification. Invalid geometry is quarantined, not repaired or snapped."}
(target / "source-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps({k: v for k, v in report.items() if k not in {"errors", "unassembledAdministrativeAreas"}}, ensure_ascii=False), flush=True)
print("quarantined:", len(errors), flush=True)

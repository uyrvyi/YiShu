"""Extract a fixed OSM snapshot and audit river/boundary alignment without snapping."""

import hashlib
import json
import sys
from pathlib import Path
import xml.etree.ElementTree as ET

import osmium
from pyproj import Transformer
from shapely import from_wkb
from shapely.geometry import box, mapping, shape
from shapely.ops import transform, unary_union

source = Path(sys.argv[1])
target = Path(sys.argv[2])
expected = {
    "shanghai-261003.osm.pbf": "cf16ce105a024b9ba304bf09c6f6985dc49acd55bbeac3d3f126e72bc1822d10",
    "jingan-full.osm": "74127b21927fd17580bbcac5354dd3ddb2c20fb2f1fb85230c2e5e081a74d5d0",
    "baoshan-full.osm": "cf0ae600438347ed4ea9178b7d111e77f6451babeaf0c58692e63f521acaab5c",
}
sources = []
for name, digest in expected.items():
    path = source.with_name(name)
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise ValueError("OSM snapshot integrity mismatch: " + name)
    if path.suffix == ".osm":
        for obj in ET.parse(path).getroot():
            if obj.tag in {"node", "way", "relation"} and obj.attrib["timestamp"] > "2026-10-03T20:20:50Z":
                raise ValueError("Supplement is newer than the common snapshot")
    sources.append(path)
factory = osmium.geom.WKBFactory()
features = []
seen = set()
errors = []
projector = Transformer.from_crs("EPSG:4326", "EPSG:32651", always_xy=True).transform

def objects():
    for path in sources:
        yield from osmium.FileProcessor(str(path)).with_areas()


for obj in objects():
    if not (obj.is_area() or obj.is_way()):
        continue
    tags = dict(obj.tags)
    admin = tags.get("boundary") == "administrative" and tags.get("admin_level") in {"4", "5", "6"}
    water = tags.get("natural") == "water" or tags.get("waterway") == "riverbank"
    river = obj.is_way() and tags.get("waterway") in {"river", "canal"}
    if not ((obj.is_area() and (admin or water)) or river):
        continue
    try:
        encoded = factory.create_multipolygon(obj) if obj.is_area() else factory.create_linestring(obj)
        geometry = from_wkb(encoded)
        if geometry.is_empty or not geometry.is_valid:
            raise ValueError("invalid source geometry")
        kind = "boundary" if admin else "water-area" if obj.is_area() else "water-line"
        oid = ("w" if obj.from_way() else "r") + str(obj.orig_id()) if obj.is_area() else "w" + str(obj.id)
        if (kind, oid) in seen:
            continue
        seen.add((kind, oid))
        features.append({
            "type": "Feature", "id": oid,
            "bbox": list(geometry.bounds),
            "properties": {"kind": kind, "osmId": oid, "tags": tags},
            "geometry": mapping(geometry),
        })
    except (RuntimeError, ValueError) as error:
        errors.append({"id": obj.id, "reason": str(error)})

collection = {"type": "FeatureCollection", "features": features}
target.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")))
admins = [f for f in features if f["properties"]["kind"] == "boundary"]
huangpu = [f for f in features if "黄浦江" in json.dumps(f["properties"]["tags"], ensure_ascii=False) and f["properties"]["kind"] == "water-line"]
pudong = [f for f in admins if f["properties"]["tags"].get("name:zh", f["properties"]["tags"].get("name")) == "浦东新区"]
audit = {
    "source": source.name,
    "sha256": expected[source.name],
    "sources": expected,
    "snapshot": "2026-10-03T20:20:50Z",
    "boundaryCount": len(admins),
    "waterAreaCount": sum(f["properties"]["kind"] == "water-area" for f in features),
    "waterLineCount": sum(f["properties"]["kind"] == "water-line" for f in features),
    "boundaries": [{"id": f["id"], "tags": f["properties"]["tags"]} for f in admins],
    "errors": errors,
    "alignment": {"status": "not_evaluated"},
}
# Evaluate a riverside window, excluding east/west inland and coastal district edges.
window = transform(projector, box(121.44, 31.20, 121.55, 31.26))
if huangpu and len(pudong) == 1:
    river_shape = unary_union([transform(projector, shape(f["geometry"])) for f in huangpu]).intersection(window)
    boundary = transform(projector, shape(pudong[0]["geometry"])).boundary.intersection(window)
    if not river_shape.is_empty and not boundary.is_empty:
        samples = [boundary.interpolate(i / 100, normalized=True) for i in range(101)]
        distances = sorted(p.distance(river_shape) for p in samples)
        audit["alignment"] = {
            "status": "candidate_only", "riverLengthM": river_shape.length,
            "boundaryLengthM": boundary.length,
            "medianCenterlineOffsetM": distances[50], "p95CenterlineOffsetM": distances[95],
            "maxCenterlineOffsetM": distances[-1],
            "note": "Same source is not proof of accuracy. No geometry was snapped or altered.",
        }
        water_window = box(121.44, 31.20, 121.55, 31.26)
        water_area = unary_union([
            transform(projector, shape(f["geometry"])) for f in features
            if f["properties"]["kind"] == "water-area" and shape(f["geometry"]).intersects(water_window)
        ])
        audit["alignment"]["boundaryOutsideWaterM"] = boundary.difference(water_area).length
target.with_suffix(".audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2))
print(json.dumps({k: v for k, v in audit.items() if k not in {"boundaries", "errors"}}, ensure_ascii=False))

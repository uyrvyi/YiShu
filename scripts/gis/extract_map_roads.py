"""Major roads only, using the same frozen OSM extracts as the map background."""

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

import osmium
from shapely import from_wkb
from shapely.geometry import mapping

source, target = map(Path, sys.argv[1:3])
factory, counts, errors = osmium.geom.WKBFactory(), Counter(), []
minimum = {"motorway": 6, "trunk": 7, "primary": 9, "secondary": 11}
with (target / "roads.geojsonseq").open("w") as stream:
    for obj in osmium.FileProcessor(str(source)).with_locations().with_filter(osmium.filter.EntityFilter(osmium.osm.WAY)):
        tags = dict(obj.tags)
        highway = tags.get("highway", "")
        kind = highway.removesuffix("_link")
        if kind not in minimum:
            continue
        try:
            geometry = from_wkb(factory.create_linestring(obj))
            if geometry.is_empty or not geometry.is_valid:
                raise ValueError("invalid source road")
            feature = {"type": "Feature", "properties": {"osmId": "w" + str(obj.id), "kind": kind,
                        "link": highway.endswith("_link"), "bridge": tags.get("bridge", "no"), "tunnel": tags.get("tunnel", "no")},
                       "tippecanoe": {"layer": "road", "minzoom": minimum[kind]}, "geometry": mapping(geometry)}
            stream.write(json.dumps(feature, separators=(",", ":")) + "\n")
            counts[highway] += 1
        except (RuntimeError, ValueError) as error:
            errors.append({"id": obj.id, "reason": str(error)})
report = {"snapshot": "2026-10-03T20:20:50Z", "source": "OpenStreetMap / Geofabrik", "counts": dict(counts),
          "filteredSha256": hashlib.file_digest(source.open("rb"), "sha256").hexdigest(), "errors": errors,
          "excluded": ["tertiary", "residential", "service", "unclassified", "track", "path", "footway", "cycleway"],
          "note": "Background reference lines only; not road navigation or actual transportation routing."}
(target / "road-report.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report))

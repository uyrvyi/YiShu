"""Check bundled geometry, not only the pre-quantization GIS extraction."""

import json
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import Point, box, shape
from shapely.ops import transform, unary_union

root = Path(".local/water-source")
rendered = json.loads((root / "shanghai-rendered.geojson").read_text())["features"]
source = json.loads((root / "shanghai-details.geojson").read_text())["features"]
districts = [f for f in rendered if f["properties"]["level"] == "district"]
waters = [f for f in rendered if f["properties"]["level"] in {"rivers", "lakes"}]
assert len(districts) == 16 and len(waters) > 0
for f in rendered:
    g = shape(f["geometry"])
    assert g.is_valid and not g.is_empty, f["properties"]["code"]
    assert f["properties"]["source"] == "OSM"
    if f["properties"]["level"] == "district":
        # Label anchors are not quantized; allow the sub-meter topology error.
        assert g.buffer(1e-5).covers(Point(f["properties"]["center"]))
project = Transformer.from_crs("EPSG:4326", "EPSG:32651", always_xy=True).transform
window = transform(project, box(121.44, 31.20, 121.55, 31.26))
pudong = next(f for f in districts if f["properties"]["code"] == "310115")
original = next(f for f in source if f["properties"]["kind"] == "boundary" and f["properties"]["osmId"] == "r398348")
boundary = transform(project, shape(pudong["geometry"])).boundary.intersection(window)
before = transform(project, shape(original["geometry"])).boundary.intersection(window)
water = unary_union([transform(project, shape(f["geometry"])) for f in waters])
outside = boundary.difference(water).length
error = boundary.hausdorff_distance(before)
assert outside <= 1, ("pudong_river_alignment", outside)
assert error < 1, ("quantization_error_m", error)
endpoints = json.loads((root / "preview-endpoints.json").read_text())
assert len(endpoints) == 4
for endpoint in endpoints:
    point = endpoint["point"]
    assert shape(endpoint["geometry"]).buffer(1e-9).covers(Point(point["lng"], point["lat"])), endpoint["code"]
report = {"districts":len(districts), "waterAreas":len(waters), "invalidGeometry":0,
          "sampleBounds":[121.44,31.20,121.55,31.26], "boundaryOutsideWaterM":outside,
          "boundaryQuantizationErrorM":error,
          "previewDistrictEndpointsInside":len(endpoints),
          "scope":"Shanghai riverside sample only; not national or legal-boundary certification"}
(root / "shanghai-rendered.audit.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report))

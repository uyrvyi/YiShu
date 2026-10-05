"""Compare source shared river boundaries to decoded, delivered MVT geometry."""

import json
import sqlite3
import sys
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import box, shape
from shapely.ops import transform, unary_union

root = Path(sys.argv[1])
project = Transformer.from_crs("EPSG:4326", "EPSG:32651", always_xy=True).transform
window = transform(project, box(121.44, 31.20, 121.55, 31.26))
admins = json.loads((root / "shanghai-admin.geojson").read_text())["features"]
districts = {f["properties"]["name"]: transform(project, shape(f["geometry"])) for f in admins}
features = json.loads((root / "decoded-shanghai.geojson").read_text())["features"]
water = unary_union([transform(project, shape(f["geometry"])) for f in features if f["properties"]["layer"] == "water"])
boundaries = unary_union([transform(project, shape(f["geometry"])) for f in features if f["properties"]["layer"] == "boundary"])
checks = []
for name in ["黄浦区", "徐汇区", "虹口区", "杨浦区"]:
    shared = districts[name].boundary.intersection(districts["浦东新区"].boundary).intersection(window)
    if shared.is_empty:
        continue
    samples = [shared.interpolate(i / 100, normalized=True) for i in range(101)]
    maximum = max(p.distance(boundaries) for p in samples)
    outside = shared.difference(water.buffer(1)).length
    assert maximum < 2, (name, maximum)
    assert outside < 2, (name, outside)
    checks.append({"district": name, "sharedBoundaryM": round(shared.length, 3),
                   "maxTileOffsetM": round(maximum, 3), "outsideWaterWith1mToleranceM": round(outside, 3)})
assert checks and any(c["district"] == "黄浦区" for c in checks)
labels = json.loads((root / "labels.json").read_text())
picker = json.loads(Path("apps/mobile/src/regions/data/pca-code.json").read_text())
province_names = {p["name"] for p in labels if p["level"] == 4}
missing_provinces = [p["name"] for p in picker if p["name"] not in province_names]
assert not missing_provinces, missing_provinces
with sqlite3.connect("file:" + str(root / "national-20261003-v2.mbtiles") + "?mode=ro", uri=True) as conn:
    assert conn.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    tiles = [{"zoom": z, "count": count, "maxBytes": maximum, "meanBytes": round(mean)}
             for z, count, maximum, mean in conn.execute("SELECT zoom_level,count(*),max(length(tile_data)),avg(length(tile_data)) FROM tiles GROUP BY zoom_level")]
report = {"checks": checks, "pickerProvinceLabelCoverage": len(picker), "missingProvinceLabels": missing_provinces,
          "tileStatistics": tiles, "status": "PASS", "scope": "Shanghai sampled river segments and 31 mainland provincial labels; not nationwide legal accuracy or every district coverage certification."}
(root / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps(report, ensure_ascii=False))

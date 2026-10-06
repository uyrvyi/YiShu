"""Extract pinned NLSC Kinmen data for inspection, not runtime publication."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile

from pyproj import CRS, Transformer
import shapefile
from shapely import union_all
from shapely.geometry import mapping, shape
from shapely.ops import transform


SOURCES = {
    "county": {
        "file": "nlsc-county-20261006.zip",
        "sha256": "0c6fca34a92b92ef3e9a41957e403cb89e814bb64942ca7c7e51c746f913d49d",
        "stem": "COUNTY_MOI_1090820",
        "url": "https://maps.nlsc.gov.tw/download/縣市界線(TWD97經緯度).zip",
        "dataset": "https://data.gov.tw/dataset/7442",
        "listingVersion": "2020/8",
        "listingUpdated": "2025-11-18",
    },
    "town": {
        "file": "nlsc-town-20261006.zip",
        "sha256": "e028e5a750eee48cf7913330655e5e5c5bb1f176868fbd0afdfc661fca60557c",
        "stem": "TOWN_MOI_1120317",
        "url": "https://maps.nlsc.gov.tw/download/鄉鎮市區界線(TWD97經緯度).zip",
        "dataset": "https://data.gov.tw/dataset/7441",
        "listingVersion": "2023/3/23",
        "listingUpdated": "2025-11-18",
    },
}
COUNTY_NAME = "金門縣"
TOWNS = {
    "09020010": "金城鎮",
    "09020020": "金沙鎮",
    "09020030": "金湖鎮",
    "09020040": "金寧鄉",
    "09020050": "烈嶼鄉",
    "09020060": "烏坵鄉",
}
LICENSE = "https://data.gov.tw/license"


def read_kinmen(path, spec):
    if hashlib.sha256(path.read_bytes()).hexdigest() != spec["sha256"]:
        raise ValueError(f"source_sha_mismatch: {path.name}")
    selected = []
    with zipfile.ZipFile(path) as archive:
        stem = spec["stem"]
        crs = CRS.from_wkt(archive.read(stem + ".prj").decode("utf-8"))
        if crs.to_epsg() != 3824:
            raise ValueError("unexpected_source_crs")
        # Actual DBF bytes are UTF-8; the town XML's Big5 label is not reliable.
        streams = {ext: io.BytesIO(archive.read(stem + "." + ext))
                   for ext in ("shp", "shx", "dbf")}
        with shapefile.Reader(**streams, encoding="utf-8") as reader:
            for record in reader.iterShapeRecords():
                props = record.record.as_dict()
                if props.get("COUNTYNAME") != COUNTY_NAME:
                    continue
                if props.get("COUNTYCODE") != "09020":
                    raise ValueError("county_identity_mismatch")
                geom = shape(record.shape.__geo_interface__)
                if geom.is_empty or not geom.is_valid or geom.geom_type not in (
                    "Polygon", "MultiPolygon"
                ):
                    raise ValueError("invalid_source_polygon")
                selected.append((props, geom))
    return selected


def inspect(source_dir, output_dir):
    counties = read_kinmen(source_dir / SOURCES["county"]["file"], SOURCES["county"])
    towns = read_kinmen(source_dir / SOURCES["town"]["file"], SOURCES["town"])
    if len(counties) != 1 or len(towns) != 6:
        raise ValueError("unexpected_kinmen_feature_count")
    if {p["TOWNCODE"]: p["TOWNNAME"] for p, _ in towns} != TOWNS:
        raise ValueError("town_identity_mismatch")
    towns.sort(key=lambda row: row[0]["TOWNCODE"])
    all_rows = [("county", *counties[0])] + [("town", *row) for row in towns]
    wgs84 = Transformer.from_crs(3824, 4326, always_xy=True, allow_ballpark=False)
    metric = Transformer.from_crs(3824, 3825, always_xy=True, allow_ballpark=False)
    features, summaries = [], []
    for kind, props, original in all_rows:
        converted = transform(wgs84.transform, original)
        if not converted.is_valid or converted.is_empty:
            raise ValueError("invalid_transformed_polygon")
        polygons = list(converted.geoms) if converted.geom_type == "MultiPolygon" else [converted]
        projected = transform(metric.transform, original)
        features.append({
            "type": "Feature",
            "properties": {**props, "sourceKind": kind, "sourceSha256": SOURCES[kind]["sha256"]},
            "geometry": mapping(converted),
        })
        summaries.append({
            "kind": kind, "attributes": props, "valid": True,
            "geometryType": converted.geom_type, "bounds": list(converted.bounds),
            "polygonCount": len(polygons),
            "vertexCount": sum(len(p.exterior.coords) + sum(len(r.coords) for r in p.interiors) for p in polygons),
            "areaKm2": round(projected.area / 1_000_000, 6),
        })
    county_metric = transform(metric.transform, counties[0][1])
    town_metrics = [transform(metric.transform, g) for _, g in towns]
    town_union = union_all(town_metrics)
    difference = county_metric.symmetric_difference(town_union)
    attribution = [
        "內政部國土測繪中心 2020 直轄市、縣市界線(TWD97經緯度)，COUNTY_MOI_1090820。",
        "內政部國土測繪中心 2023 鄉鎮市區界線(TWD97經緯度)，TOWN_MOI_1120317。",
        "此開放資料依政府資料開放授權條款第1版進行公眾釋出；使用須遵守該條款。",
        LICENSE,
    ]
    payload = json.dumps({
        "type": "FeatureCollection", "features": features, "attribution": attribution,
        "status": "inspection_only_not_for_publication",
    }, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    output_dir.mkdir(parents=True, exist_ok=True)
    geometry_file = output_dir / "kinmen-nlsc-wgs84.geojson"
    geometry_file.write_bytes(payload)
    report = {
        "schemaVersion": 1, "inspectedOn": "2026-10-06",
        "status": "source_acquired_runtime_mapping_pending",
        "provider": "內政部國土測繪中心", "license": LICENSE,
        "attribution": attribution, "sources": SOURCES,
        "sourceCrs": "EPSG:3824", "outputCrs": "EPSG:4326",
        "coordinateTransform": {"operation": wgs84.description, "accuracyMetres": wgs84.accuracy},
        "encoding": "UTF-8 (actual DBF, strict decode)",
        "features": summaries,
        "countyVsTownUnion": {
            "symmetricDifferenceKm2": round(difference.area / 1_000_000, 6),
            "symmetricDifferenceFraction": difference.area / county_metric.area,
            "overlappingTownAreaKm2": round((sum(g.area for g in town_metrics) - town_union.area) / 1_000_000, 6),
            "note": "Different source versions; differences are measured, not repaired or snapped.",
        },
        "geometry": {"file": geometry_file.name, "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)},
        "scope": {
            "sourceCountyCode": "09020", "containsWuqiu": True,
            "runtimeCountyCode": "350527", "mapping": "pending_not_equated",
            "note": "Preserve all six source towns; no automatic inclusion/exclusion or OSM ID relabelling.",
        },
        "release": "pending",
    }
    (output_dir / "inspection.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=Path(".local/regions"))
    parser.add_argument("--output-dir", type=Path, default=Path(".local/maps/kinmen-nlsc-20261006"))
    args = parser.parse_args()
    print(json.dumps(inspect(args.source_dir, args.output_dir), ensure_ascii=False, indent=2))

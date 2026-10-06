"""Explicit geometry adapters, limited to frozen source evidence and official identities.

Derived candidates are not authoritative boundary certification. No missing district
may fall back to a city centroid or an unrelated development-zone polygon.
"""

import hashlib

import osmium
from shapely import from_wkb, union_all

from division_changes import evidence_file, text_content

SUPPLEMENT_SHA256 = "40526d291894aaededae5bb81a16ba90128ebfc6701e50ca472a23c8406f1072"
CHINA_SHA256 = "c3c03b41b6a72d38f70558b9ab64bbc8a0baf92e6e99d1b5f12f95e208ec71d4"
HANNAN_SOURCE_URL = "https://www.whkfq.gov.cn/xxgk/zc/qtzdgk/gwhqzf/202201/t20220124_1912899.html"
HANNAN_SOURCE_SHA256 = "54f836a2e1996b048b5fa30e5bacdb9dc9cdcdb4f61d1e9b559288594f6f2de7"
HANNAN_STREETS = {17345599: ("420113001", "纱帽街道"), 17345598: ("420113002", "邓南街道"),
                 17345597: ("420113003", "东荆街道"), 8667530: ("420113004", "湘口街道")}
XIONGAN_COUNTIES = {"r4820132": ("130629", "容城县"), "r4820114": ("130632", "安新县"),
                   "r4820130": ("130638", "雄县")}


def extract_supplement(source):
    with source.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != SUPPLEMENT_SHA256:
            raise ValueError("supplement_snapshot_integrity_failed")
    tags, geometries = {}, {}

    class Relations(osmium.SimpleHandler):
        def relation(self, relation):
            tags[relation.id] = dict(relation.tags)

    Relations().apply_file(str(source))
    factory = osmium.geom.WKBFactory()
    for obj in osmium.FileProcessor(str(source)).with_areas().with_filter(osmium.filter.EntityFilter(osmium.osm.AREA)):
        if not obj.from_way():
            geometry = from_wkb(factory.create_multipolygon(obj))
            if geometry.is_empty or not geometry.is_valid:
                raise ValueError("invalid_supplement_geometry")
            geometries[obj.orig_id()] = geometry
    return tags, geometries


def supplement_candidates(areas, official, tags, geometries, hannan_text):
    result = {area["osmId"]: dict(area) for area in areas}
    wendeng = tags[5652862]
    if wendeng.get("name") != "文登区" or wendeng.get("division_code") != "371003" or \
       "admin_level" in wendeng or official.get("371003") != "文登区" or "r5652862" in result:
        raise ValueError("wendeng_adapter_source_mismatch")
    geometry = geometries[5652862]
    result["r5652862"] = {"osmId": "r5652862", "name": "文登区", "code": "371003", "level": 6,
                          "tags": wendeng, "geometry": geometry, "point": geometry.representative_point(),
                          "pointMethod": "interior_representative_point",
                          "geometryAdapter": {"method": "missing_admin_level_from_official_county_identity",
                                              "sourceSha256": SUPPLEMENT_SHA256, "parentSourceSha256": CHINA_SHA256}}
    if "原汉南区所辖四个街道" not in hannan_text or "蔡甸区三个街道" not in hannan_text or \
       official.get("420113") != "汉南区":
        raise ValueError("hannan_official_scope_failed")
    for rid, (code, name) in HANNAN_STREETS.items():
        source = tags[rid]
        if source.get("name") != name or source.get("division_code") != code or source.get("admin_level") != "8":
            raise ValueError("hannan_street_identity_failed")
    zone = result["r3076294"]
    if zone["name"] != "武汉经济技术开发区（汉南区）" or zone["code"] != "420113" or \
       not all(rid in zone["subareas"] for rid in HANNAN_STREETS):
        raise ValueError("hannan_zone_identity_failed")
    geometry = union_all([geometries[rid] for rid in sorted(HANNAN_STREETS)])
    if not geometry.is_valid or geometry.is_empty or geometry.geom_type not in {"Polygon", "MultiPolygon"} or \
       not zone["geometry"].covers(geometry):
        raise ValueError("hannan_union_geometry_failed")
    zone.update(name="汉南区", geometry=geometry, point=geometry.representative_point(),
                pointMethod="interior_representative_point",
                geometryAdapter={"method": "union_of_four_official_county_street_candidates",
                                 "sourceRelationIds": ["r" + str(rid) for rid in sorted(HANNAN_STREETS)],
                                 "sourceSha256": SUPPLEMENT_SHA256, "parentSourceSha256": CHINA_SHA256,
                                 "officialScopeUrl": HANNAN_SOURCE_URL, "officialScopeSha256": HANNAN_SOURCE_SHA256,
                                 "excludedFunctionalZone": "r3076294"})
    parent = result["r3442995"]
    provinces = [area for area in result.values() if area["level"] == 4 and area["name"] == "河北省"]
    if len(provinces) != 1:
        raise ValueError("baoding_province_ambiguous")
    province = provinces[0]
    if parent["name"] != "保定市" or parent["code"] not in {"1306", "130600"}:
        raise ValueError("baoding_parent_identity_failed")
    shapes = []
    for rid, (code, name) in XIONGAN_COUNTIES.items():
        area = result[rid]
        if official.get(code) != name or area["name"] != name or area["code"] not in {"", code} or \
           int(rid[1:]) not in parent["subareas"] or not province["geometry"].covers(area["geometry"]):
            raise ValueError("baoding_county_evidence_failed:" + rid)
        shapes.append(area["geometry"])
    geometry = union_all([parent["geometry"], *shapes])
    if not geometry.is_valid:
        raise ValueError("baoding_parent_union_failed")
    repair = {"method": "official_city_identity_union_with_existing_source_subareas",
              "baseRelationId": "r3442995", "addedRelationIds": sorted(XIONGAN_COUNTIES),
              "scope": "audit_parent_containment_only", "sourceSha256": CHINA_SHA256}
    parent.update(geometry=geometry, geometryAdapter=repair)
    for rid in XIONGAN_COUNTIES:
        result[rid]["parentGeometryAdapter"] = repair
    return list(result.values())


def apply_supplements(areas, official, source, directory):
    tags, geometries = extract_supplement(source)
    hannan_text = text_content(evidence_file(directory, "hannan-scope.html", HANNAN_SOURCE_SHA256).decode())
    return supplement_candidates(areas, official, tags, geometries, hannan_text)

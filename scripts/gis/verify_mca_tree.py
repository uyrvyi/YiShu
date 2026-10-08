"""Compare a browser-saved official national tree without certifying boundary changes."""

import argparse
from collections import Counter
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re

from audit_endpoint_release import flatten_regions

SOURCE_URL = "https://dmfw.mca.gov.cn/XzqhVersionPublish.html"
SOURCE_SHA256 = "c6611ef7f3a0cd16b45005957f1733190104f2618653e99ba3947ab59beb0abb"
MUNICIPALITIES = {"11", "12", "31", "50"}
CITIES_WITHOUT_DISTRICTS = {"4419", "4420", "4604", "6202"}
PROVINCES = {"11", "12", "13", "14", "15", "21", "22", "23", "31", "32", "33",
             "34", "35", "36", "37", "41", "42", "43", "44", "45", "46", "50",
             "51", "52", "53", "54", "61", "62", "63", "64", "65"}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
             "param", "source", "track", "wbr"}


class OfficialTreeParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.frames = []
        self.roots = []
        self.tree_count = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = set(attrs.get("class", "").split())
        in_tree = attrs.get("id") == "xzqhTree" or any(f["tree"] for f in self.frames)
        if attrs.get("id") == "xzqhTree":
            self.tree_count += 1
        frame = {"tag": tag, "tree": in_tree, "node": None, "label": None}
        if in_tree and tag == "div" and "layui-tree-set" in classes:
            node = {"code": attrs.get("data-id", ""), "name": "", "children": []}
            parent = next((f["node"] for f in reversed(self.frames) if f["node"]), None)
            (parent["children"] if parent else self.roots).append(node)
            frame["node"] = node
        if in_tree and tag == "span" and "layui-tree-txt" in classes:
            node = next((f["node"] for f in reversed(self.frames) if f["node"]), None)
            if node is None or node["name"]:
                raise ValueError("official_tree_label_invalid")
            frame["label"] = {"node": node, "parts": []}
        if tag not in VOID_TAGS:
            self.frames.append(frame)

    def handle_data(self, data):
        label = next((f["label"] for f in reversed(self.frames) if f["label"]), None)
        if label:
            label["parts"].append(data)

    def handle_endtag(self, tag):
        if tag in VOID_TAGS:
            return
        if not self.frames or self.frames[-1]["tag"] != tag:
            raise ValueError("official_tree_html_structure_invalid")
        frame = self.frames.pop()
        if frame["label"]:
            label = frame["label"]
            label["node"]["name"] = "".join(label["parts"]).strip()


def parse_tree(html):
    parser = OfficialTreeParser()
    parser.feed(html)
    parser.close()
    if parser.frames or parser.tree_count != 1 or len(parser.roots) != 1:
        raise ValueError("official_tree_structure_invalid")
    root = parser.roots[0]
    if root["code"] != "00" or root["name"] != "中国":
        raise ValueError("official_tree_root_invalid")
    seen, provinces, regions = set(), set(), []

    def visit(node):
        code = node["code"]
        if code in seen or not node["name"]:
            raise ValueError("official_tree_duplicate_or_empty_identity")
        seen.add(code)
        for child in node["children"]:
            visit(child)

    visit(root)
    for province in root["children"]:
        pcode = province["code"]
        if pcode in {"81", "82", "资料暂缺"}:
            expected = {"81": "香港特别行政区", "82": "澳门特别行政区", "资料暂缺": "台湾省"}[pcode]
            if province["name"] != expected or province["children"]:
                raise ValueError("official_tree_unavailable_placeholder_invalid")
            continue
        if pcode not in PROVINCES or not province["children"]:
            raise ValueError("official_tree_province_invalid")
        provinces.add(pcode)
        for city in province["children"]:
            ccode = city["code"]
            if not re.fullmatch(r"\d{4}|\d{6}", ccode) or not ccode.startswith(pcode):
                raise ValueError("official_tree_city_parent_invalid")
            if len(ccode) == 6:
                if ccode.endswith("00"):
                    raise ValueError("official_tree_direct_county_invalid")
                children = [city]
                cname = province["name"] if pcode in MUNICIPALITIES else city["name"]
                ccode = ccode[:4]
            elif not city["children"]:
                if ccode not in CITIES_WITHOUT_DISTRICTS:
                    raise ValueError("official_tree_unexpected_empty_city")
                children = [{"code": ccode + "00", "name": city["name"], "children": []}]
                cname = city["name"]
            else:
                children = city["children"]
                cname = province["name"] if pcode in MUNICIPALITIES else city["name"]
            for district in children:
                code = district["code"]
                if not re.fullmatch(r"\d{6}", code) or not code.startswith(ccode) or district["children"]:
                    raise ValueError("official_tree_district_parent_invalid")
                regions.append({"code": code, "province": province["name"], "provinceCode": pcode,
                                "city": cname, "cityCode": ccode, "district": district["name"],
                                "kind": "city" if code.endswith("00") else "county"})
    if len({r["code"] for r in regions}) != len(regions):
        raise ValueError("official_tree_duplicate_region")
    return provinces, regions


def compare_catalog(official, candidate):
    by_code = {r["code"]: r for r in candidate}
    if len(by_code) != len(candidate):
        raise ValueError("candidate_duplicate_code")
    official_by_code = {r["code"]: r for r in official}
    if len(official_by_code) != len(official):
        raise ValueError("official_duplicate_code")
    checks = []
    for code in sorted(official_by_code.keys() | by_code.keys()):
        expected, current = official_by_code.get(code), by_code.get(code)
        result = "missing_candidate" if current is None else "absent_from_official_tree" if expected is None else \
            "match" if all(current[k] == expected[k] for k in ("province", "provinceCode", "city", "cityCode", "district", "kind")) else "identity_mismatch"
        checks.append({"code": code, "official": expected, "candidate": current, "result": result})
    return checks


def load_snapshot(path):
    content = path.read_bytes()
    if hashlib.sha256(content).hexdigest() != SOURCE_SHA256:
        raise ValueError("official_source_sha_mismatch")
    html = content.decode("utf-8")
    if "<!-- saved from url=(0047)" + SOURCE_URL + " -->" not in html:
        raise ValueError("official_source_origin_mismatch")
    return parse_tree(html)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(".local/regions/mca-query-shanghai-20261006.html"))
    parser.add_argument("--regions", type=Path, default=Path("apps/mobile/src/regions/data/pca-current.json"))
    parser.add_argument("--output", type=Path, default=Path("data/maps/audit/mca-live-tree-20261006.json"))
    args = parser.parse_args()
    provinces, official = load_snapshot(args.source)
    if provinces != PROVINCES:
        raise ValueError("official_tree_national_province_coverage_incomplete")
    candidate_bytes = args.regions.read_bytes()
    checks = compare_catalog(official, flatten_regions(json.loads(candidate_bytes)))
    report = {"schemaVersion": 1, "inspectedOn": "2026-10-06", "effectiveThrough": None,
              "source": {"url": SOURCE_URL, "sha256": SOURCE_SHA256, "capture": "Edge Save Page complete DOM",
                         "treeRequest": "xzqh/getList?code=0&trimCode=true&maxLevel=3"},
              "candidateSha256": hashlib.sha256(candidate_bytes).hexdigest(), "officialProvinces": len(provinces),
              "officialRegions": len(official), "results": dict(sorted(Counter(c["result"] for c in checks).items())),
              "identityComparison": "PASS" if checks and all(c["result"] == "match" for c in checks) else "FAIL",
              "checks": checks, "runtimeFilesChanged": False,
              "scope": "Complete mainland identity tree observed on capture date, not a certificate of its effective date, all boundary changes, geometry or map publication approval."}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "checks"}, ensure_ascii=False))
    if report["identityComparison"] != "PASS":
        raise SystemExit("mca_tree_identity_comparison_failed")


if __name__ == "__main__":
    main()

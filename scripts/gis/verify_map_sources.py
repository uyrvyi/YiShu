"""Verify the frozen public extracts and pre-snapshot API supplements."""

import hashlib
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

root, target = map(Path, sys.argv[1:3])
expected = {
    "china-261003.osm.pbf": "c3c03b41b6a72d38f70558b9ab64bbc8a0baf92e6e99d1b5f12f95e208ec71d4",
    "taiwan-261003.osm.pbf": "1bed4bb1bed004395e72ed1d29838eb369258c0fbd2f461d80f221b71a801632",
    "tibet-full.osm": "8395dbf7a91b7349c2def1184f650a3a666122c04f3639986652b33395d5b8a8",
    "hainan-full.osm": "03e2ef4c6a048e50f41d08ae4e2c97230490871c74fedb3c375db7f5122ff687",
}
sources = []
for name, digest in expected.items():
    path = root / name
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    assert actual == digest, name
    newest = None
    if name.endswith(".osm"):
        objects = ET.parse(path).getroot()
        newest = max(o.attrib.get("timestamp", "") for o in objects)
        assert newest <= "2026-10-03T20:20:50Z", (name, newest)
    sources.append({"file": name, "sha256": digest, "bytes": path.stat().st_size, "newestObject": newest})
report = {"snapshot": "2026-10-03T20:20:50Z", "status": "PASS", "sources": sources,
          "urls": ["https://download.geofabrik.de/asia/china-261003.osm.pbf", "https://download.geofabrik.de/asia/taiwan-261003.osm.pbf",
                   "https://api.openstreetmap.org/api/0.6/relation/153292/full", "https://api.openstreetmap.org/api/0.6/relation/2128285/full"]}
(target / "source-integrity.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report))

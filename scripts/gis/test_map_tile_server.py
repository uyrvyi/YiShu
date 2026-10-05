import gzip
import json
import sqlite3
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path


class StaticTileServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        root = Path(cls.directory.name)
        cls.payload = gzip.compress(b"", mtime=0)
        with sqlite3.connect(root / "national-20261003-v2.mbtiles") as connection:
            connection.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
            connection.execute("INSERT INTO tiles VALUES (2,1,2,?)", (cls.payload,))
        (root / "labels.json").write_text("[]")
        (root / "source-report.json").write_text("{}")
        (root / "ODBL_LICENSE").write_text("ODbL")
        (root / "NOTICE.txt").write_text("OpenStreetMap contributors")
        cls.process = subprocess.Popen(["python", "scripts/gis/serve_map_tiles.py", str(root)])
        for _ in range(100):
            try:
                urllib.request.urlopen("http://127.0.0.1:4180/health", timeout=1).close()
                return
            except urllib.error.URLError:
                time.sleep(0.05)
        cls.process.terminate()
        cls.process.wait()
        raise RuntimeError("server did not start")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=5)
        cls.directory.cleanup()

    def request(self, path, headers=None):
        return urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:4180" + path, headers=headers or {}), timeout=3)

    def test_xyz_is_converted_to_tms_and_gzip_is_declared(self):
        with self.request("/maps/national-20261003-v2/2/1/1.pbf") as response:
            self.assertEqual(response.read(), self.payload)
            self.assertEqual(response.headers["Content-Encoding"], "gzip")
            self.assertIn("immutable", response.headers["Cache-Control"])
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")

    def test_missing_tiles_are_valid_empty_vector_tiles(self):
        with self.request("/maps/national-20261003-v2/12/10/10.pbf") as response:
            self.assertEqual(gzip.decompress(response.read()), b"")

    def test_etags_support_revalidation(self):
        with self.request("/maps/national-20261003-v2/labels.json") as response:
            etag = response.headers["ETag"]
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/maps/national-20261003-v2/labels.json", {"If-None-Match": etag})
        self.assertEqual(error.exception.code, 304)

    def test_invalid_tiles_and_arbitrary_files_are_rejected(self):
        for path, status in [("/maps/national-20261003-v2/13/1/1.pbf", 400), ("/maps/national-20261003-v2/2/4/1.pbf", 400), ("/maps/national-20261003-v2/../../.env", 404), ("/.env", 404), ("/maps/unknown/labels.json", 404)]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request(path)
            self.assertEqual(error.exception.code, status)

    def test_health_is_not_immutable(self):
        with self.request("/health") as response:
            self.assertEqual(json.load(response)["status"], "ok")
            self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_public_license_and_derivative_database(self):
        with self.request("/maps/national-20261003-v2/NOTICE.txt") as response:
            self.assertIn(b"OpenStreetMap", response.read())
        with self.request("/maps/national-20261003-v2/ODBL_LICENSE") as response:
            self.assertEqual(response.read(), b"ODbL")
        with self.request("/maps/national-20261003-v2/national-20261003-v2.mbtiles") as response:
            self.assertEqual(response.read()[:16], b"SQLite format 3\x00")
            self.assertIn("attachment", response.headers["Content-Disposition"])


if __name__ == "__main__":
    unittest.main()

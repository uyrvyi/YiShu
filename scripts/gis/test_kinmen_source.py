import hashlib
import io
from pathlib import Path
import tempfile
import unittest
import zipfile

from pyproj import CRS
import shapefile

from inspect_kinmen_source import read_kinmen


class KinmenSourceTests(unittest.TestCase):
    def fixture(self, folder, code="09020", epsg=3824, invalid=False):
        streams = {ext: io.BytesIO() for ext in ("shp", "shx", "dbf")}
        with shapefile.Writer(**streams, shapeType=shapefile.POLYGON, encoding="utf-8") as writer:
            writer.field("COUNTYCODE", "C", 8)
            writer.field("COUNTYNAME", "C", 12)
            if invalid:
                ring = [(118, 24), (119, 25), (118, 25), (119, 24), (118, 24)]
            else:
                ring = [(118, 24), (118, 25), (119, 25), (119, 24), (118, 24)]
            writer.poly([ring])
            writer.record(code, "金門縣")
        path = Path(folder) / "source.zip"
        with zipfile.ZipFile(path, "w") as archive:
            for ext, stream in streams.items():
                archive.writestr("boundary." + ext, stream.getvalue())
            archive.writestr("boundary.prj", CRS.from_epsg(epsg).to_wkt())
        return path, {"stem": "boundary", "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    def test_reads_original_identity_and_valid_polygon(self):
        with tempfile.TemporaryDirectory() as folder:
            path, spec = self.fixture(folder)
            result = read_kinmen(path, spec)
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0][0]["COUNTYCODE"], "09020")
            self.assertNotIn("osmId", result[0][0])
            self.assertTrue(result[0][1].is_valid)

    def test_rejects_changed_download(self):
        with tempfile.TemporaryDirectory() as folder:
            path, spec = self.fixture(folder)
            spec["sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "source_sha_mismatch"):
                read_kinmen(path, spec)

    def test_rejects_unexpected_crs(self):
        with tempfile.TemporaryDirectory() as folder:
            path, spec = self.fixture(folder, epsg=4326)
            with self.assertRaisesRegex(ValueError, "unexpected_source_crs"):
                read_kinmen(path, spec)

    def test_rejects_relabelled_county_code(self):
        with tempfile.TemporaryDirectory() as folder:
            path, spec = self.fixture(folder, code="350527")
            with self.assertRaisesRegex(ValueError, "county_identity_mismatch"):
                read_kinmen(path, spec)

    def test_rejects_self_intersection_without_repair(self):
        with tempfile.TemporaryDirectory() as folder:
            path, spec = self.fixture(folder, invalid=True)
            with self.assertRaisesRegex(ValueError, "invalid_source_polygon"):
                read_kinmen(path, spec)


if __name__ == "__main__":
    unittest.main()

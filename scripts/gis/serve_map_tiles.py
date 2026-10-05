"""Read-only, versioned static MBTiles service behind the HTTPS gateway."""

import gzip
import hashlib
import json
import re
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

root = Path(sys.argv[1]).resolve()
snapshot = "national-20261003-v2"
database = root / (snapshot + ".mbtiles")
if not database.is_file():
    raise SystemExit("Build the MBTiles archive first")
database_uri = database.as_uri() + "?mode=ro&immutable=1"
empty = gzip.compress(b"", mtime=0)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == f"/maps/{snapshot}/{snapshot}.mbtiles":
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.sqlite3")
            self.send_header("Content-Length", str(database.stat().st_size))
            self.send_header("Content-Disposition", f'attachment; filename="{database.name}"')
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            # Publish the ODbL derivative without loading the archive into memory.
            try:
                with database.open("rb") as source:
                    while block := source.read(65536):
                        self.wfile.write(block)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        match = re.fullmatch(r"/maps/" + snapshot + r"/(\d{1,2})/(\d{1,6})/(\d{1,6})\.pbf", path)
        compressed = False
        if match:
            z, x, y = map(int, match.groups())
            if not 2 <= z <= 12 or not 0 <= x < 2**z or not 0 <= y < 2**z:
                self.send_error(400)
                return
            with sqlite3.connect(database_uri, uri=True) as connection:
                row = connection.execute("SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?", (z, x, 2**z - 1 - y)).fetchone()
            payload = bytes(row[0]) if row else empty
            content_type, compressed = "application/vnd.mapbox-vector-tile", payload[:2] == b"\x1f\x8b"
        elif path in {f"/maps/{snapshot}/labels.json", f"/maps/{snapshot}/source-report.json"}:
            payload = (root / path.rsplit("/", 1)[1]).read_bytes()
            content_type = "application/json; charset=utf-8"
        elif path in {f"/maps/{snapshot}/ODBL_LICENSE", f"/maps/{snapshot}/NOTICE.txt"}:
            payload = (root / path.rsplit("/", 1)[1]).read_bytes()
            content_type = "text/plain; charset=utf-8"
        elif path == "/health":
            payload = json.dumps({"status": "ok", "snapshot": snapshot}).encode()
            content_type = "application/json"
        else:
            self.send_error(404)
            return
        etag = '"' + hashlib.sha256(payload).hexdigest() + '"'
        self.send_response(304 if self.headers.get("If-None-Match") == etag else 200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if path != "/health" else "no-store")
        self.send_header("ETag", etag)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.headers.get("If-None-Match") != etag:
            self.wfile.write(payload)

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("0.0.0.0", 4180), Handler).serve_forever()

"""Serve the editor on loopback with the Python standard library."""
import argparse
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
ASSETS = {"css", "js", "music", "sfx", "vfx", "vendor", "examples"}


class EditorFiles(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        requested = unquote(urlsplit(self.path).path)
        parts = requested.lstrip("/").split("/")
        if requested in ("/", "/index.html"):
            self.path = "/index.html"
        elif ((parts[0] not in ASSETS and requested != "/models/rife422lite_fp16.onnx")
              or any(part.startswith(".") for part in parts)
              or not (ROOT / requested.lstrip("/")).resolve().is_relative_to(ROOT)):
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(HTTPStatus.NOT_FOUND)
        return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5178)
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), EditorFiles) as server:
        print(f"Open http://127.0.0.1:{server.server_port} in your browser.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass

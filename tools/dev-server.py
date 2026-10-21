#!/usr/bin/env python3
"""Serves the repo to the live ui2 page for v3 development without reloading
the page (a reload stands you up from the table).

    python3 tools/dev-server.py            # http://localhost:5174
    // in the gpokr page console:
    await import("http://localhost:5174/_v1/shim/boot.js")

The browser caches a module per URL for the life of the page, so a fresh
build needs fresh URLs: bump the /_vN/ prefix (it is stripped here) after
calling window.__gptShim.teardown() and deleting window.__gptShim.
"""
import http.server
import os
import re
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5174
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def translate_path(self, path):
        return super().translate_path(re.sub(r"^/_v[^/]+", "", path))

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, *a):
        pass


Handler.extensions_map[".js"] = "text/javascript"
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

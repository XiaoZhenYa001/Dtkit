"""Run existing tool regressions against a fresh build after frame isolation."""

import functools
import http.server
import os
import runpy
import sys
import threading
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


if __name__ == "__main__":
    available = ["region-mirror-ui-smoke.py", "sticky-notes-ui-smoke.py",
                 "context-menu-ui-smoke.py", "startup-manager-ui-smoke.py",
                 "portable-tools-ui-smoke.py", "ui-smoke.py"]
    selected = sys.argv[1:] or available
    if any(name not in available for name in selected):
        raise SystemExit("Only the listed frame isolation regression scripts can be selected")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT / "dist")))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    previous_url = os.environ.get("DTKIT_TEST_BASE_URL")
    os.environ["DTKIT_TEST_BASE_URL"] = f"http://127.0.0.1:{server.server_port}"
    try:
        for name in selected:
            print(f"Frame isolation regression: {name}", flush=True)
            runpy.run_path(str(ROOT / "tests" / name), run_name="__main__")
    finally:
        if previous_url is None:
            os.environ.pop("DTKIT_TEST_BASE_URL", None)
        else:
            os.environ["DTKIT_TEST_BASE_URL"] = previous_url
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)

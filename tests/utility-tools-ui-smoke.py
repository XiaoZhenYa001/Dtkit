"""Compatibility entry point for the expanded three-tool UI regression."""

import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "utility_improvements", Path(__file__).with_name("utility-tools-improvements-ui-smoke.py")
)
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)

if __name__ == "__main__":
    with suite.multi.production_url() as base_url:
        suite.run(base_url)

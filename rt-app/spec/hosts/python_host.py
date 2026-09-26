"""Contract host for the Python implementations (run with: sh hosts/python.sh hosts/python_host.py).

Every hosts/python/*.py module defines SUBJECTS; add a module per group of subjects."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from rt_app.conformance import run_host

FOLDER = Path(__file__).parent / "python"


def load_subjects() -> dict:
    sys.path.insert(0, str(FOLDER))  # modules may import each other (e.g. `from storage import memory_store`)
    subjects: dict = {}
    for path in sorted(FOLDER.glob("*.py")):
        spec = importlib.util.spec_from_file_location(path.stem, path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules[path.stem] = module
        spec.loader.exec_module(module)
        for name, factory in getattr(module, "SUBJECTS", {}).items():
            if name in subjects:
                raise RuntimeError(f"Duplicate subject {name} in {path.name}")
            subjects[name] = factory
    return subjects


if __name__ == "__main__":
    run_host(load_subjects())

"""Atomic JSON write (stdlib only) — shared by every pipeline, heavy or not."""
from __future__ import annotations
import json, os, tempfile
from pathlib import Path


def write_atomic(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(obj, fh, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        # a failed write left its tmp*.tmp beside the data and the deploy shipped it; a kill (SIGTERM, SIGKILL)
        # still can, so deploy_pages.sh drops tmp*.tmp too
        os.unlink(tmp)
        raise

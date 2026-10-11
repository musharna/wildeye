"""pytest plugin: run the suite with the wall clock moved SHIFT_DAYS days ahead (default 400).

Load it explicitly: `python -m pytest pipeline/tests -p pipeline.tests.clock_shift` (needs `time-machine`). A test that writes a fixed
date into code that compares against the wall clock (archive_frame prunes frames older than keep_days) passes on the day it
is written and fails some weeks later, on every PR at once (2026-10-10: three such tests). The weekly clock-shift workflow
runs the suite this far ahead, so a fixed date fails there over a year before it fails in CI.
"""

import datetime as dt
import os

import time_machine

_travel = None


def pytest_configure(config):
    global _travel
    days = int(os.environ.get("SHIFT_DAYS", "400"))
    _travel = time_machine.travel(
        dt.datetime.now(dt.UTC) + dt.timedelta(days=days), tick=True
    )
    _travel.start()


def pytest_unconfigure(config):
    if _travel is not None:
        _travel.stop()

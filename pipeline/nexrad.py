"""Locate and download the newest NEXRAD Level II volume for a radar site."""
from __future__ import annotations
import datetime as dt
import re
from pathlib import Path
import boto3, botocore

BUCKET = "unidata-nexrad-level2"

def _client():
    return boto3.client("s3", config=botocore.config.Config(signature_version=botocore.UNSIGNED))

_TS = re.compile(r"(\d{8})_(\d{6})_V06$")

def key_time(key: str) -> dt.datetime:
    m = _TS.search(key)
    if not m:
        raise ValueError(f"not a volume key: {key}")
    return dt.datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").replace(tzinfo=dt.UTC)

def nearest_key(keys: list[str], target: dt.datetime, tolerance: dt.timedelta) -> str | None:
    vols = [k for k in keys if k.endswith("_V06")]
    if not vols:
        return None
    best = min(vols, key=lambda k: abs(key_time(k) - target))
    return best if abs(key_time(best) - target) <= tolerance else None

def list_day_keys(site: str, day: dt.datetime) -> list[str]:
    s3 = _client()
    prefix = f"{day:%Y/%m/%d}/{site}/"
    keys, token = [], None
    while True:
        kw = {"Bucket": BUCKET, "Prefix": prefix, "MaxKeys": 1000}
        if token:
            kw["ContinuationToken"] = token
        r = s3.list_objects_v2(**kw)
        keys += [o["Key"] for o in r.get("Contents", [])]
        token = r.get("NextContinuationToken")
        if not token:
            return keys

def volume_key_at(site: str, target: dt.datetime, tolerance: dt.timedelta = dt.timedelta(minutes=20)) -> str | None:
    """Scan nearest `target` (UTC) within tolerance, looking at the target day and, near midnight, its neighbour."""
    keys = list_day_keys(site, target)
    if (target - target.replace(hour=0, minute=0, second=0, microsecond=0)) < tolerance:
        keys += list_day_keys(site, target - dt.timedelta(days=1))
    elif (target.replace(hour=23, minute=59, second=59) - target) < tolerance:
        keys += list_day_keys(site, target + dt.timedelta(days=1))
    return nearest_key(keys, target, tolerance)

def pick_latest_key(keys: list[str]) -> str | None:
    vols = [k for k in keys if k.endswith("_V06")]
    return max(vols) if vols else None

def latest_volume_key(site: str, now: dt.datetime | None = None) -> str | None:
    now = now or dt.datetime.now(dt.UTC)
    s3 = _client()
    for day in (now, now - dt.timedelta(days=1)):
        prefix = f"{day:%Y/%m/%d}/{site}/"
        keys, token = [], None
        while True:
            kw = {"Bucket": BUCKET, "Prefix": prefix, "MaxKeys": 1000}
            if token:
                kw["ContinuationToken"] = token
            r = s3.list_objects_v2(**kw)
            keys += [o["Key"] for o in r.get("Contents", [])]
            token = r.get("NextContinuationToken")
            if not token:
                break
        key = pick_latest_key(keys)
        if key:
            return key
    return None

def download_volume(key: str, dest_dir: Path) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / Path(key).name
    if not dest.exists():
        _client().download_file(BUCKET, key, str(dest))
    return dest

"""Locate and download the newest NEXRAD Level II volume for a radar site."""
from __future__ import annotations
import datetime as dt
from pathlib import Path
import boto3, botocore

BUCKET = "unidata-nexrad-level2"

def _client():
    return boto3.client("s3", config=botocore.config.Config(signature_version=botocore.UNSIGNED))

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

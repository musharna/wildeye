"""IUCN Red List category per taxon in pipeline/taxa.json → public/data/seed/iucn.json.

Not a map layer: an enrichment the sightings info box reads (src/data/iucn.js).
Two calls per binomial taxon against the Red List API v4 (token required):

  GET /api/v4/taxa/scientific_name?genus_name=G&species_name=s
      → summary list of assessments (year_published, latest, scopes, url, assessment_id);
        the summary carries NO category, so
  GET /api/v4/assessment/{assessment_id}   (the latest Global-scope one)
      → red_list_category.code, year_published, citation, url

Genus-level entries in taxa.json (e.g. "Bombus") have no species epithet and are
skipped (recorded in `_meta.skipped`). Terms of Use §3: IUCN "places no
restrictions on use of the IUCN Red List Categories associated with each named
taxonomic entity"; §6 asks for citation incl. the Red List version — that is why
the citation string and assessment year travel with the category.
"""

from __future__ import annotations
import argparse
import datetime as dt
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from .atomic import write_atomic

log = logging.getLogger("iucn")
HERE = Path(__file__).parent
BASE = "https://api.iucnredlist.org/api/v4"
UA = "wildeye (github.com/musharna/wildeye)"
GLOBAL_SCOPE = "1"
PAUSE_S = 2.0  # IUCN asks for "appropriate delays between your API calls" (api.iucnredlist.org); 2 s = builder-brief rule 7
TERMS_URL = "https://www.iucnredlist.org/terms/terms-of-use"


class Unauthorized(RuntimeError):
    pass


def _get_json(url: str, token: str, timeout: int = 60, tries: int = 4) -> dict | None:
    """None on 404 (taxon/assessment not in the Red List); Unauthorized on 401/403;
    5xx retried with backoff then raised."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Authorization": token,
            "Accept": "application/json",
        },
    )
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (401, 403):
                raise Unauthorized(
                    f"IUCN API {e.code} for {url.split('?')[0]} — IUCN_TOKEN rejected"
                ) from None
            if e.code >= 500 and i < tries - 1:
                wait = 2 ** (i + 1)
                log.warning("IUCN %s → HTTP %s, retry in %ds", url, e.code, wait)
                time.sleep(wait)
                continue
            raise
    raise RuntimeError(f"IUCN API gave up on {url}")


def split_name(sci: str) -> tuple[str, str] | None:
    """'Megaptera novaeangliae' → ('Megaptera', 'novaeangliae'); genus-only → None."""
    parts = (sci or "").strip().split()
    if len(parts) < 2:
        return None
    return parts[0], parts[1]


def pick_latest_global(assessments: list[dict]) -> dict | None:
    """The `latest: true` assessment whose scopes include Global (code "1"); if the
    taxon has only regional assessments, the latest of those; else None."""
    latest = [a for a in assessments or [] if a.get("latest") is True]
    glob = [
        a
        for a in latest
        if any(str(s.get("code")) == GLOBAL_SCOPE for s in a.get("scopes") or [])
    ]
    pool = glob or latest
    if not pool:
        return None
    return max(pool, key=lambda a: str(a.get("year_published") or ""))


def normalise_assessment(a: dict) -> dict:
    cat = a.get("red_list_category") or {}
    code = cat.get("code")
    if not code:
        raise ValueError(
            f"assessment {a.get('assessment_id')} has no red_list_category.code"
        )
    # Only what §3 (category) and §6 (citation incl. version) need, plus scope when a regional
    # assessment stands in; no other Red List Data is republished in the public seed (§4).
    return {
        "category": code,
        "year": int(a["year_published"])
        if str(a.get("year_published") or "").isdigit()
        else None,
        "citation": a.get("citation"),
        "url": a.get("url"),
        "scope": _scope_label(a.get("scopes") or []),
    }


def _scope_label(scopes: list[dict]) -> str | None:
    """'Global' when the Global scope (code "1") is present, else the first scope's English name."""
    if any(str(s.get("code")) == GLOBAL_SCOPE for s in scopes):
        return "Global"
    return ((scopes[0].get("description") or {}).get("en")) if scopes else None


def lookup(
    taxon: dict, token: str, fetch=None, sleep=time.sleep
) -> tuple[dict | None, str | None]:
    """(entry, reason) — entry None when skipped/missing, reason says why."""
    fetch = fetch or _get_json
    gs = split_name(taxon["sci"])
    if not gs:
        return None, "genus-level taxon, no species epithet"
    q = urllib.parse.urlencode({"genus_name": gs[0], "species_name": gs[1]})
    summ = fetch(f"{BASE}/taxa/scientific_name?{q}", token)
    sleep(PAUSE_S)
    if summ is None:
        return None, "not found in the Red List"
    pick = pick_latest_global(summ.get("assessments") or [])
    if not pick:
        return None, "no latest assessment"
    full = fetch(f"{BASE}/assessment/{pick['assessment_id']}", token)
    sleep(PAUSE_S)
    if full is None:
        return None, f"assessment {pick['assessment_id']} not found"
    return normalise_assessment(full), None


def build(taxa: list[dict], token: str, fetch=None, sleep=time.sleep) -> dict:
    """taxon id → entry, plus `_meta` (skipped/missing per taxon, failures, generated_at)."""
    out, skipped, failures = {}, {}, {}
    for t in taxa:
        try:
            entry, why = lookup(t, token, fetch, sleep)
        except Unauthorized:
            raise
        except Exception as e:  # noqa: BLE001 — one bad taxon must not lose the others
            failures[t["id"]] = repr(e)
            log.error("%s FAILED: %r", t["id"], e)
            continue
        if entry is None:
            skipped[t["id"]] = why
            log.info("%s skipped: %s", t["id"], why)
        else:
            out[t["id"]] = entry
            log.info("%s %s (%s)", t["id"], entry["category"], entry["year"])
    out["_meta"] = {
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "IUCN Red List of Threatened Species, API v4 (api.iucnredlist.org)",
        "terms": TERMS_URL,
        "skipped": skipped,
        "failures": failures,
    }
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/seed/iucn.json"))
    ap.add_argument("--taxa", default=None, help="comma-separated taxon ids")
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    token = os.environ.get("IUCN_TOKEN")
    if not token:
        if not a.out.exists():
            write_atomic(a.out, {})
            log.warning("wrote empty %s", a.out)
        sys.exit(
            "IUCN_TOKEN is not set. Register at https://api.iucnredlist.org/users/sign_up, then store it with:\n"
            "  printf 'IUCN_TOKEN=%s\\n' '<paste>' >> ~/.config/wildeye/env"
        )
    taxa = json.loads((HERE / "taxa.json").read_text())
    if a.taxa:
        keep = set(a.taxa.split(","))
        taxa = [t for t in taxa if t["id"] in keep]
    t0 = time.time()
    result = build(taxa, token)
    n = len(result) - 1
    if n == 0:
        raise SystemExit("no IUCN categories resolved — not overwriting the seed")
    write_atomic(a.out, result)
    log.info(
        "wrote %d categories (%d skipped, %d failed) in %.0fs",
        n,
        len(result["_meta"]["skipped"]),
        len(result["_meta"]["failures"]),
        time.time() - t0,
    )


if __name__ == "__main__":
    main()

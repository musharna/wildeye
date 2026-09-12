"""pipeline/h5n1.py — Nextstrain avian-flu H5N1 aggregation.

Every fixture below is a VERBATIM slice of live responses fetched 2026-09-12:
`https://nextstrain.org/charon/getAvailable` and
`https://data.nextstrain.org/avian-flu_h5n1-cattle-outbreak_ha.json`.
"""
import collections
import datetime as dt
import json

import pytest

from pipeline.h5n1 import (
    GISAID_REQUESTS,
    HOST_CATEGORIES,
    aggregate,
    available,
    dataset_url,
    decode_body,
    decimal_to_date,
    host_category,
    locate,
    main,
    parse_dataset,
    resolve,
    tip_date,
    week_ends,
)

# --- verbatim live fixtures --------------------------------------------------------------------
# tips copied unmodified from the cattle-outbreak HA build (node_attrs trimmed to the keys used)
TIP_CATTLE = {"name": "A/cattle/CA/24-032639-001-original/2024", "node_attrs": {"num_date": {"value": 2024.827, "confidence": [2024.827, 2024.827], "inferred": False}, "division": {"value": "California"}, "country": {"value": "USA"}, "subtype": {"value": "h5n1"}, "region": {"value": "North America"}, "host": {"value": "Cattle"}, "genoflu": {"value": "B3.13"}}}
TIP_CHICKEN = {"name": "A/chicken/CA/24-033695-001-original/2024", "node_attrs": {"num_date": {"value": 2024.816, "confidence": [2024.816, 2024.816], "inferred": False}, "division": {"value": "California"}, "country": {"value": "USA"}, "subtype": {"value": "h5n1"}, "region": {"value": "North America"}, "host": {"value": "Avian"}, "genoflu": {"value": "B3.13"}}}
# a real imprecise tip: metadata date was "2024-XX-XX", so augur inferred it with a 0.8-year interval
TIP_IMPRECISE = {"name": "A/Cattle/USA/24-033483-002/2024", "node_attrs": {"num_date": {"value": 2024.001, "confidence": [2024.001, 2024.809], "inferred": True, "raw_value": "2024-XX-XX"}, "country": {"value": "USA"}, "subtype": {"value": "h5n1"}, "region": {"value": "North America"}, "host": {"value": "Cattle"}, "genoflu": {"value": "B3.13"}}}
GEO_RESOLUTIONS = [
    {"key": "region", "demes": {"North America": {"latitude": 28.2367447, "longitude": -97.738017}}},
    {"key": "country", "demes": {"USA": {"latitude": 38.916963, "longitude": -98.891372}}},
    {"key": "division", "demes": {"Idaho": {"latitude": 43.810421, "longitude": -114.351215}, "Utah": {"latitude": 39.4225192, "longitude": -111.7143583}, "Texas": {"latitude": 31.146868, "longitude": -99.188758}, "California": {"latitude": 36.7014631, "longitude": -118.755997}}},
]
CHARON = {"datasets": [
    {"request": "avian-flu/h5n1-cattle-outbreak/ha", "snapshots": True, "buildUrl": None},
    {"request": "avian-flu/h5n1-d1.1/genome", "snapshots": True, "buildUrl": None},
    {"request": "avian-flu/h5n1/ha/2y", "snapshots": True, "buildUrl": None},
]}


def build(tips, geo=GEO_RESOLUTIONS, title="Ongoing influenza A/H5N1 cattle outbreak in North America (HA segment)"):
    """An Auspice v2 JSON shaped like the live file: meta + a nested tree whose leaves are tips."""
    return {"meta": {"title": title, "updated": "2026-09-07", "build_url": "https://github.com/nextstrain/avian-flu",
                     "data_provenance": [{"name": "USDA"}, {"name": "GenBank"}], "geo_resolutions": geo},
            "tree": {"name": "ROOT", "children": [{"name": "NODE_1", "children": tips}]}}


def tip(name, value, host, division=None, country="USA", region="North America", clade="B3.13", conf=None):
    a = {"num_date": {"value": value, "confidence": conf or [value, value]}, "host": {"value": host},
         "country": {"value": country}, "region": {"value": region}, "genoflu": {"value": clade}}
    if division:
        a["division"] = {"value": division}
    return {"name": name, "node_attrs": a}


# --- discovery ---------------------------------------------------------------------------------
def test_dataset_url_and_resolve_fail_loud_on_a_vanished_build():
    """Mutant: `resolve` returning [r for r in requests if r in listed] instead of raising —
    caught by the RuntimeError assertion; the positive control proves resolve is not
    unconditionally raising."""
    assert dataset_url("avian-flu/h5n1-cattle-outbreak/ha") == "https://data.nextstrain.org/avian-flu_h5n1-cattle-outbreak_ha.json"
    listed = available(fetch=lambda url, timeout=300: CHARON)
    assert listed == ["avian-flu/h5n1-cattle-outbreak/ha", "avian-flu/h5n1-d1.1/genome", "avian-flu/h5n1/ha/2y"]
    # positive control: the configured open builds resolve
    assert resolve(("avian-flu/h5n1-cattle-outbreak/ha", "avian-flu/h5n1-d1.1/genome"), listed) == [
        "avian-flu/h5n1-cattle-outbreak/ha", "avian-flu/h5n1-d1.1/genome"]
    with pytest.raises(RuntimeError, match="charon no longer lists"):
        resolve(("avian-flu/h5n1-cattle-outbreak/ha", "avian-flu/h5n1/ha/1y"), listed)
    assert "avian-flu/h5n1/ha/2y" in GISAID_REQUESTS, "the GISAID build is declined by name, not by absence"


# --- dates -------------------------------------------------------------------------------------
def test_decimal_dates_use_augur_convention_and_imprecise_tips_are_refused():
    """Mutant: dropping the `- 0.5`/`+ 0.5` half-day term in decimal_to_date shifts
    2024.827 to 2024-10-28; mutant: `> max_span_days` → `>= max_span_days` lets the
    0.8-year interval through. Both caught here."""
    assert decimal_to_date(2024.827) == dt.date(2024, 10, 29)  # leap year: 366 days
    assert decimal_to_date(2026.527) == dt.date(2026, 7, 12)
    assert decimal_to_date(2026.0) == dt.date(2026, 1, 1) and decimal_to_date(2025.999) == dt.date(2025, 12, 31)
    assert tip_date(TIP_CATTLE["node_attrs"]["num_date"]) == dt.date(2024, 10, 29)
    assert tip_date(TIP_IMPRECISE["node_attrs"]["num_date"]) is None, "a 0.8-year interval cannot be put in a week"
    assert tip_date({"value": 2026.5, "confidence": [2026.5, 2026.525]}) is None, "9 days > 7"
    assert tip_date({"value": 2026.5, "confidence": [2026.5, 2026.508]}) == decimal_to_date(2026.5), "2.9 days is fine"
    assert tip_date({}) is None and tip_date({"value": None}) is None
    assert week_ends(dt.date(2026, 7, 12), 3) == [dt.date(2026, 7, 12), dt.date(2026, 7, 5), dt.date(2026, 6, 28)]


# --- host categories ---------------------------------------------------------------------------
def test_host_category_five_classes_on_every_real_host_string():
    """Every distinct `host` value in the two open builds (read live 2026-09-12), verbatim, with
    its tip count. Mutant: dropping "bovidae"/"dairy" from CATTLE_WORDS sends 9 cattle tips to
    other; mutant: substring instead of whole-word host matching makes "Brown-headed Cowbird"
    cattle and "Eastern cottontail" a bird; mutant: POULTRY before WILD_FIRST makes turkeyvulture
    poultry. The canonical strings are the positive controls."""
    real = {  # host → (tip count across both builds, expected class)
        "Cattle": (4871, "cattle"), "CATTLE, DOMESTIC DAIRY (NO BREED SPECIFIED)": (7, "cattle"), "Bovidae": (2, "cattle"),
        "Human": (34, "human"), "Nonhuman Mammal": (318, "other"), "House fly": (2, "other"), "Pekania pennanti": (1, "other"),
        "Ursus sp.": (1, "other"), None: (11, "other"),
        "Himantopus mexicanus": (2, "wild bird"), "Brant Goose": (2, "wild bird"), "Sialia": (1, "wild bird"),
        "BLACK-CROWNED NIGHT HERON": (1, "wild bird"), "MARBLED GODWIT": (1, "wild bird"), "Fringillidae": (1, "wild bird"),
        "Aquila chrysaetos": (1, "wild bird"), "Anser caerulescens caerulescens": (1, "wild bird"), "HAWK, RED-SHOULDERED": (1, "wild bird"),
        "Larus fuscus": (1, "wild bird"), "Leucophaeus atricilla": (1, "wild bird"), "Eastern Screech Owl": (1, "wild bird"),
        "Buteo platypterus": (1, "wild bird"), "HAWK, COOPER'S": (1, "wild bird"),
        "Embden Goose": (1, "poultry"), "Duck hybrid": (1, "poultry"),
    }
    tally = collections.Counter()
    for host, (n, want) in real.items():
        got = host_category(host, "A/x/USA/1/2025")
        assert got == want, (host, got)
        tally[got] += n
    assert set(tally) == set(HOST_CATEGORIES) and len(HOST_CATEGORIES) == 5
    assert tally == {"cattle": 4880, "human": 34, "other": 333, "wild bird": 16, "poultry": 2}
    # guards against substring matching
    assert host_category("Brown-headed Cowbird", "") == "wild bird" and host_category("Eastern cottontail", "") == "other"
    # "Avian" is split by the strain-name host token
    def cat(strain):
        return host_category("Avian", strain)
    assert cat("A/turkeyvulture/Utah/25-1234/2025") == "wild bird"
    assert cat("A/turkey/Indiana/25-1234/2025") == "poultry"
    assert cat("A/domesticduck/Ohio/25-1/2025") == "poultry" and cat("A/Layer chicken/x/1/2025") == "poultry"
    assert cat(TIP_CHICKEN["name"]) == "poultry"
    assert cat("A/duck/Iowa/25-1/2025") == "wild bird" and cat("A/Canadagoose/NY/25-1/2025") == "wild bird"
    assert host_category("Cattle", TIP_CATTLE["name"]) == "cattle"


# --- parsing + geocoding -----------------------------------------------------------------------
def test_parse_dataset_reads_real_tips_and_locate_falls_back_to_country():
    """Mutant: `locate` iterating ("country", "division", "region") puts the Idaho sample on the
    USA centroid — caught by the division assertion; the Utah-less tip is the positive control
    that the country fallback still fires."""
    gj = build([TIP_CATTLE, TIP_CHICKEN, TIP_IMPRECISE])
    samples, demes, info = parse_dataset(gj, "avian-flu/h5n1-cattle-outbreak/ha")
    assert len(samples) == 2 and info["imprecise_date"] == 1 and info["tips"] == 3
    assert info["url"].endswith("avian-flu_h5n1-cattle-outbreak_ha.json") and info["provenance"] == ["USDA", "GenBank"]
    assert [s["category"] for s in samples] == ["cattle", "poultry"]
    assert samples[0]["clade"] == "B3.13" and samples[0]["clade_field"] == "genoflu"
    assert "strain" in samples[0], "strain is read for de-duplication but must never be written out"
    assert locate(samples[0], demes) == ("division", "California", -118.756, 36.70146)
    no_div = {"division": None, "country": "USA", "region": "North America"}
    assert locate(no_div, demes) == ("country", "USA", -98.89137, 38.91696)
    assert locate({"division": "Nordland Fylke", "country": "Norway", "region": "Europe"}, demes) is None


# --- aggregation -------------------------------------------------------------------------------
def test_aggregate_bins_weeks_dedupes_across_builds_and_drops_unplaceable():
    """Mutant: `(data_end - s["date"]).days // WEEK_D` → `// 1` puts the 2026-07-05 sample in its
    own bin 7 and empties week 1 — caught by the two-bin assertion. Mutant: dropping the `seen`
    de-duplication double-counts the shared strain, caught by counts["duplicate"] and n."""
    end = dt.date(2026, 7, 12)
    a = [tip("A/cattle/ID/26-1/2026", 2026.527, "Cattle", "Idaho"),            # 2026-07-12, bin 0
         tip("A/chicken/ID/26-2/2026", 2026.527, "Avian", "Idaho"),            # 2026-07-12, bin 0
         tip("A/snowgoose/ID/26-3/2026", 2026.508, "Avian", "Idaho", clade="D1.1"),  # 2026-07-05, bin 1
         tip("A/cattle/NO/26-9/2026", 2026.527, "Cattle", "Nordland Fylke", country="Norway", region="Europe"),  # no centroid at any level → no_geo
         tip("A/cattle/UT/25-1/2025", 2025.500, "Cattle", "Utah")]             # a year old → outside
    b = [tip("A/CATTLE/ID/26-1/2026", 2026.527, "Cattle", "Idaho"),            # same strain, other build
         tip("A/Utah/26-7/2026", 2026.520, "Human", None)]                     # 2026-07-09 → USA centroid
    demes = {g["key"]: g["demes"] for g in GEO_RESOLUTIONS}
    feats, counts = aggregate([(parse_dataset(build(a), "x")[0], demes),
                               (parse_dataset(build(b), "y")[0], demes)], weeks=4)
    assert counts["data_end"] == end.isoformat()
    assert counts["samples"] == 7 and counts["duplicate"] == 1 and counts["no_geo"] == 1
    assert counts["outside_window"] == 1 and counts["in_window"] == 4 and counts["locations"] == 2
    idaho = next(f for f in feats if f["properties"]["loc"] == "Idaho")
    p = idaho["properties"]
    assert idaho["geometry"]["coordinates"] == [-114.35121, 43.81042]
    assert p["level"] == "division" and p["country"] == "USA" and p["region"] == "North America"
    assert p["n"] == 3 and p["hosts"] == {"poultry": 1, "wild bird": 1, "cattle": 1}
    assert p["clades"] == {"B3.13": 2, "D1.1": 1} and p["raw_hosts"] == {"Cattle": 1, "Avian": 2}
    assert p["weeks"] == [{"w": "2026-07-12", "n": {"cattle": 1, "poultry": 1}, "c": {"B3.13": 2}},
                          {"w": "2026-07-05", "n": {"wild bird": 1}, "c": {"D1.1": 1}}], "empty bins are omitted"
    usa = next(f for f in feats if f["properties"]["loc"] == "USA")
    assert usa["properties"]["level"] == "country" and usa["properties"]["hosts"] == {"human": 1}
    blob = json.dumps(feats)
    for leaked in ("26-1", "A/cattle", "24-032639"):
        assert leaked not in blob, f"{leaked}: no strain or accession may reach the output"
    assert aggregate([], weeks=4)[0] == [] and aggregate([], weeks=4)[1]["locations"] == 0


def test_main_end_to_end_writes_the_layer_file(tmp_path, monkeypatch):
    """Mutant: writing `"features": []` when nothing is placeable instead of SystemExit — the
    empty-run assertion catches it; the populated run is the positive control."""
    import pipeline.h5n1 as m
    gj = build([TIP_CATTLE, TIP_CHICKEN, TIP_IMPRECISE])
    seen = []

    def fake(url, timeout=300):
        seen.append(url)
        return CHARON if url == m.CHARON else gj

    monkeypatch.setattr(m, "_get_json", fake)
    monkeypatch.setattr(m, "OPEN_REQUESTS", ("avian-flu/h5n1-cattle-outbreak/ha",))
    out = tmp_path / "h5n1.geojson"
    m.main(["--out", str(out), "--weeks", "60", "--sleep", "0"])
    d = json.loads(out.read_text())
    assert seen[0] == m.CHARON and seen[1].endswith("avian-flu_h5n1-cattle-outbreak_ha.json")
    assert d["data_end"] == "2024-10-29" and d["counts"]["in_window"] == 2
    assert len(d["features"]) == 1 and d["features"][0]["properties"]["loc"] == "California"
    assert d["categories"] == list(HOST_CATEGORIES) and d["clades"] == ["B3.13"] and d["clade_field"] == ["genoflu"]
    assert d["datasets"][0]["title"].startswith("Ongoing influenza A/H5N1 cattle outbreak")
    assert "GISAID" in d["source"]["declined"]["reason"] and d["source"]["declined"]["requests"] == list(GISAID_REQUESTS)
    assert "public domain" in d["source"]["licence"] and "sequencing effort" in d["source"]["note"]
    monkeypatch.setattr(m, "_get_json", lambda url, timeout=300: CHARON if url == m.CHARON else build([TIP_IMPRECISE]))
    with pytest.raises(SystemExit):
        m.main(["--out", str(out), "--weeks", "4", "--sleep", "0"])


def test_decode_body_inflates_gzip_with_or_without_the_header():
    """Mutant: `decode_body` returning json.loads(raw) unconditionally — fails on the gzip body
    (the live 0x8b failure of 2026-09-12); the plain body is the positive control."""
    import gzip as gz
    body = json.dumps(CHARON).encode()
    assert decode_body(body, None) == CHARON
    assert decode_body(gz.compress(body), "gzip") == CHARON
    assert decode_body(gz.compress(body), None) == CHARON, "served gzip without a Content-Encoding we asked for"

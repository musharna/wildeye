"""pipeline/neon_vectors.py — fixtures are trimmed from REAL NEON API responses fetched 2026-09-12
(HARV DP1.10093.001 2025-06 / 2026-06, DP1.10043.001 2026-06). Every test was watched failing on the mutant
named in its docstring before it was accepted."""

import datetime as dt
import json
from pipeline.neon_vectors import (
    fetch_sites,
    fetch_month_tables,
    tick_summary,
    mosquito_summary,
    data_months,
    build,
    main,
    PRODUCTS,
)

# tck_fielddata 2025-06 HARV (basic): counts columns are empty; one plot had no target taxa, one drag impractical (edited: row 4)
TCK_FIELD = """uid,namedLocation,domainID,siteID,plotID,plotType,nlcdClass,decimalLatitude,decimalLongitude,geodeticDatum,coordinateUncertainty,elevation,elevationUncertainty,samplingImpractical,biophysicalCriteria,samplingFrequency,collectDate,eventID,sampleID,sampleCode,samplingMethod,totalSampledArea,targetTaxaPresent,adultCount,nymphCount,larvaCount,sampleCondition,samplingProtocolVersion,measuredBy,remarks,dataQF
"a1","HARV_026.tickPlot.tck","D01","HARV","HARV_026","distributed","evergreenForest",42.412057,-72.246527,"WGS84",20.2,187.3,0.4,"OK","OK - no known exceptions","high intensity","2025-06-02T13:16Z","HARV.2025.23","HARV_026.20250602","A1","drag and flag",169,"N",,,,"No known compromise","NEON.DOC.014045vM","0009",,
"a2","HARV_001.tickPlot.tck","D01","HARV","HARV_001","distributed","deciduousForest",42.424217,-72.260096,"WGS84",20.1,202.1,0.2,"OK","OK - no known exceptions","high intensity","2025-06-02T14:38Z","HARV.2025.23","HARV_001.20250602","A2","drag and flag",161,"Y",,,,"No known compromise","NEON.DOC.014045vM","0009",,
"a3","HARV_022.tickPlot.tck","D01","HARV","HARV_022","distributed","evergreenForest",42.435458,-72.199287,"WGS84",20.2,185.9,0.5,"OK","OK - no known exceptions","high intensity","2025-06-02T17:01Z","HARV.2025.23","HARV_022.20250602","A3","drag and flag",160,"Y",,,,"No known compromise","NEON.DOC.014045vM","0009",,
"a4","HARV_004.tickPlot.tck","D01","HARV","HARV_004","distributed","mixedForest",42.426877,-72.227953,"WGS84",20.4,182.6,0.9,"logistical","OK - no known exceptions","high intensity","2025-06-03T12:27Z","HARV.2025.23",,,"drag and flag",150,,,,,,"NEON.DOC.014045vM","0009",,
"""
# tck_taxonomyProcessed 2025-06 HARV (basic), trimmed columns kept in real order
TCK_TAXO = """uid,namedLocation,siteID,domainID,plotID,collectDate,identifiedDate,sampleID,subsampleID,scientificName,acceptedTaxonID,taxonRank,family,subfamily,tribe,subtribe,genus,subgenus,specificEpithet,infraspecificEpithet,identificationQualifier,identificationReferences,identificationProtocolVersion,identificationHistoryID,scientificNameAuthorship,sexOrAge,individualCount,sampleCondition,archiveMedium,archiveFacilityID,deprecatedVialID,identifiedBy,laboratoryName,remarks,dataQF
"t1","HARV_026.tickPlot.tck","HARV","D01","HARV_026","2025-06-02T13:16Z","2025-09-01","HARV_026.20250602","HARV_026.20250602.S1","Ixodes scapularis","IXOSCA","species","Ixodidae",,,,"Ixodes",,"scapularis",,,,"v1",,"Say, 1821","Nymph",13,"OK",,,,"x","lab",,
"t2","HARV_026.tickPlot.tck","HARV","D01","HARV_026","2025-06-02T13:16Z","2025-09-01","HARV_026.20250602","HARV_026.20250602.S2","Dermacentor variabilis","DERVAR","species","Ixodidae",,,,"Dermacentor",,"variabilis",,,,"v1",,"(Say, 1821)","Male",1,"OK",,,,"x","lab",,
"t3","HARV_022.tickPlot.tck","HARV","D01","HARV_022","2025-06-02T17:01Z","2025-09-01","HARV_022.20250602","HARV_022.20250602.S1","Ixodes scapularis","IXOSCA","species","Ixodidae",,,,"Ixodes",,"scapularis",,,,"v1",,"Say, 1821","Female",1,"OK",,,,"x","lab",,
"t4","HARV_022.tickPlot.tck","HARV","D01","HARV_022","2025-06-02T17:01Z","2025-09-01","HARV_022.20250602","HARV_022.20250602.S3","Ixodidae sp.","IXOSP","family","Ixodidae",,,,,,,,,,"v1",,,"Larva",35,"OK",,,,"x","lab",,
"""
# mos_trapping 2026-06 HARV (basic): failed deployments carry trapHours 0.0 + samplingImpractical "logistical"
MOS_TRAP = """uid,namedLocation,domainID,siteID,plotID,plotType,nlcdClass,decimalLatitude,decimalLongitude,geodeticDatum,coordinateUncertainty,elevation,elevationUncertainty,setDate,collectDate,trapHours,nightOrDay,eventID,samplingImpractical,sampleID,sampleCode,samplingProtocolVersion,sampleTiming,fanStatus,catchCupStatus,trapType,CO2Status,sampleCondition,targetTaxaPresent,recordedBy,remarks,dataQF
"m1","HARV_081.mosquitoPoint.mos","D01","HARV","HARV_081","distributed","evergreenForest",42.404544,-72.254726,"WGS84",10.2,171.6,0.3,"2026-06-09T22:00Z","2026-06-09T22:00Z",0.0,,"HARV.2026.24","logistical",,,"NEON.DOC.014049vN","Field season",,,"CO2 canister",,,,"x",,
"m2","HARV_077.mosquitoPoint.mos","D01","HARV","HARV_077","distributed","evergreenForest",42.41,-72.25,"WGS84",10.2,171.6,0.3,"2026-06-23T20:51Z","2026-06-24T10:09Z",12.7,"night","HARV.2026.26","OK","HARV_077.20260624.0609","B1","NEON.DOC.014049vN","Field season","OK","OK","CO2 canister","OK","No known compromise","Y","x",,
"m3","HARV_077.mosquitoPoint.mos","D01","HARV","HARV_077","distributed","evergreenForest",42.41,-72.25,"WGS84",10.2,171.6,0.3,"2026-06-24T10:09Z","2026-06-24T20:55Z",10.8,"day","HARV.2026.26","OK","HARV_077.20260624.1855","B2","NEON.DOC.014049vN","Field season","OK","OK","CO2 canister","OK","No known compromise","Y","x",,
"""
MOS_SORT = """uid,namedLocation,domainID,siteID,plotID,setDate,collectDate,sortDate,sampleID,sampleCode,subsampleID,subsampleCode,proportionIdentified,sampleCondition,remarks,sortedBy,laboratoryName
"s1","HARV_077.mosquitoPoint.mos","D01","HARV","HARV_077","2026-06-23T20:51Z","2026-06-24T10:09Z","2026-07-01","HARV_077.20260624.0609","B1","HARV_077.20260624.0609.S.01","C1",0.500,"No known compromise",,"x","lab"
"""
# mos_expertTaxonomistIDProcessed 2026-06 HARV (basic), trimmed columns kept in real order
MOS_TAXO = """uid,namedLocation,domainID,siteID,plotID,setDate,collectDate,identifiedDate,subsampleID,subsampleCode,targetTaxaPresent,individualCount,taxonID,kingdom,phylum,class,order,family,subfamily,tribe,genus,subgenus,specificEpithet,infraspecificEpithet,scientificName,scientificNameAuthorship,taxonRank,nativeStatusCode,identificationQualifier,sex,identificationReferences,sampleCondition,identificationRemarks,remarks,identifiedBy,laboratoryName,identificationHistoryID
"i1","HARV_077.mosquitoPoint.mos","D01","HARV","HARV_077","2026-06-23T20:51Z","2026-06-24T10:09Z","2026-07-11","HARV_077.20260624.0609.S.01",,"Y",1,"AEDPUN","Animalia","Arthropoda","Insecta","Diptera","Culicidae","Culicinae","Aedini","Aedes","Ochlerotatus","punctor",,"Aedes punctor","(Kirby, 1837)","species","N",,"F","ref","No known compromise",,,"x","lab",
"i2","HARV_077.mosquitoPoint.mos","D01","HARV","HARV_077","2026-06-23T20:51Z","2026-06-24T10:09Z","2026-07-11","HARV_077.20260624.0609.S.01",,"Y",16,"AEDCAN2","Animalia","Arthropoda","Insecta","Diptera","Culicidae","Culicinae","Aedini","Aedes","Ochlerotatus","canadensis",,"Aedes canadensis","(Theobald, 1901)","species","N",,"F","ref","No known compromise",,,"x","lab",
"i3","HARV_077.mosquitoPoint.mos","D01","HARV","HARV_077","2026-06-23T20:51Z","2026-06-24T10:09Z","2026-07-11","HARV_077.20260624.1855.S.01",,"Y",11,"COQPER","Animalia","Arthropoda","Insecta","Diptera","Culicidae","Culicinae","Mansoniini","Coquillettidia","Coquillettidia","perturbans",,"Coquillettidia perturbans","(Walker, 1856)","species","N",,"M","ref","No known compromise",,,"x","lab",
"""


def test_tick_summary_effort_from_ok_drags_counts_from_lab_table_pending_without_it():
    """Mutants seen failing: samplingImpractical filter dropped (row a4 'logistical' with 150 m² → drags 4, area 640);
    STAGES map broken (Female→'unknown'); per1000 denominator swapped for drags. Row a1 (targetTaxaPresent N) still
    counts as effort → area 490."""
    s = tick_summary({"tck_fielddata": TCK_FIELD, "tck_taxonomyProcessed": TCK_TAXO})
    assert (
        s["drags"] == 3
        and s["area_m2"] == 490
        and s["count"] == 50
        and s["per1000"] == 102.04
    )
    assert s["stages"] == {"larva": 35, "nymph": 13, "adult": 2}
    assert s["genera"] == {"unidentified": 35, "Ixodes": 14, "Dermacentor": 1}
    pend = tick_summary({"tck_fielddata": TCK_FIELD})
    assert (
        pend["pending"] is True
        and pend["count"] is None
        and pend["per1000"] is None
        and pend["drags"] == 3
    )
    # no OK drag at all → None (negative), with the positive control above
    assert (
        tick_summary(
            {
                "tck_fielddata": TCK_FIELD.splitlines()[0]
                + "\n"
                + TCK_FIELD.splitlines()[4]
                + "\n"
            }
        )
        is None
    )
    assert tick_summary({}) is None


def test_mosquito_summary_trap_hours_proportion_scaling_pending():
    """Mutants seen failing: effort guard (samplingImpractical OK and trapHours>0) removed → traps 3; proportionIdentified
    scaling removed (count 28); TRAPNIGHT_HOURS changed to 12 (per_trapnight halves)."""
    s = mosquito_summary(
        {
            "mos_trapping": MOS_TRAP,
            "mos_sorting": MOS_SORT,
            "mos_expertTaxonomistIDProcessed": MOS_TAXO,
        }
    )
    assert s["traps"] == 2 and s["trap_hours"] == 23.5
    assert s["count"] == 45, (
        "17 identified at 50% sorted → 34, plus 11 with no sorting row → 1.0"
    )
    assert s["per_trapnight"] == round(45 / (23.5 / 24), 2) == 45.96
    assert s["genera"] == {"Aedes": 34, "Coquillettidia": 11}
    assert s["pending"] is False
    pend = mosquito_summary({"mos_trapping": MOS_TRAP, "mos_sorting": MOS_SORT})
    assert pend["pending"] is True and pend["count"] is None and pend["traps"] == 2
    # Each guard alone must exclude a deployment. Mutant `or`→`and` SURVIVED the real rows above (they fail both
    # guards at once) and fails here: real row m2 edited to trapHours 0.0 with "OK", and to "logistical" with 12.7 h.
    hdr, m2 = MOS_TRAP.splitlines()[0], MOS_TRAP.splitlines()[2]
    zero_ok = m2.replace(",12.7,", ",0.0,")
    failed_hours = m2.replace('"OK","HARV_077', '"logistical","HARV_077')
    assert zero_ok != m2 and failed_hours != m2
    for bad in (zero_ok, failed_hours):
        assert mosquito_summary({"mos_trapping": f"{hdr}\n{bad}\n"}) is None
    assert mosquito_summary({"mos_trapping": f"{hdr}\n{m2}\n"})["traps"] == 1, (
        "positive control: unedited row counts"
    )
    only_failed = "\n".join(MOS_TRAP.splitlines()[:2]) + "\n"
    assert (
        mosquito_summary(
            {"mos_trapping": only_failed, "mos_expertTaxonomistIDProcessed": MOS_TAXO}
        )
        is None
    )


def test_fetch_sites_and_month_tables_parse_api_shapes():
    """Mutant seen failing: `.basic.` filter removed → the expanded file (listed first) is fetched (KeyError on its url).
    The Raw taxonomist table listed alongside must never be taken for the Processed one."""
    sites_json = json.dumps(
        {
            "data": [
                {
                    "siteCode": "HARV",
                    "siteName": "Harvard Forest & Quabbin Watershed NEON",
                    "siteLatitude": 42.536911,
                    "siteLongitude": -72.172658,
                    "siteType": "CORE",
                    "dataProducts": [
                        {
                            "dataProductCode": "DP1.10093.001",
                            "availableMonths": ["2026-06", "2025-06"],
                        },
                        {
                            "dataProductCode": "DP1.10043.001",
                            "availableMonths": ["2026-06"],
                        },
                        {
                            "dataProductCode": "DP1.10072.001",
                            "availableMonths": ["2026-07"],
                        },
                    ],
                },
                {
                    "siteCode": "ABBY",
                    "siteName": "Abby Road NEON",
                    "siteLatitude": 45.76,
                    "siteLongitude": -122.33,
                    "siteType": "GRADIENT",
                    "dataProducts": [
                        {
                            "dataProductCode": "DP1.10072.001",
                            "availableMonths": ["2026-07"],
                        }
                    ],
                },
            ]
        }
    ).encode()
    seen = []

    def fetch(url, timeout=120, token=None):
        seen.append((url, token))
        if url.endswith("/sites"):
            return sites_json
        if "/data/DP1.10043.001/HARV/2026-06" in url:
            return json.dumps(
                {
                    "data": {
                        "release": "PROVISIONAL",
                        "files": [
                            {
                                "name": "NEON.D01.HARV.DP1.10043.001.mos_expertTaxonomistIDRaw.2026-06.basic.20260713T214723Z.csv",
                                "url": "https://f/raw",
                            },
                            {
                                "name": "NEON.D01.HARV.DP1.10043.001.mos_expertTaxonomistIDProcessed.2026-06.expanded.20260713T214723Z.csv",
                                "url": "https://f/exp",
                            },
                            {
                                "name": "NEON.D01.HARV.DP1.10043.001.mos_expertTaxonomistIDProcessed.2026-06.basic.20260713T214723Z.csv",
                                "url": "https://f/taxo",
                            },
                            {
                                "name": "NEON.D01.HARV.DP1.10043.001.mos_trapping.2026-06.basic.20260713T214723Z.csv",
                                "url": "https://f/trap",
                            },
                        ],
                    }
                }
            ).encode()
        return {"https://f/taxo": MOS_TAXO, "https://f/trap": MOS_TRAP}[url].encode()

    sites = fetch_sites(fetch, token="tok")
    assert sites == [
        {
            "code": "HARV",
            "name": "Harvard Forest & Quabbin Watershed NEON",
            "lat": 42.536911,
            "lon": -72.172658,
            "type": "CORE",
            "months": {"ticks": ["2025-06", "2026-06"], "mosquitoes": ["2026-06"]},
        }
    ]
    assert seen[0][1] == "tok", "token header goes to the API"
    tables, release = fetch_month_tables(
        "mosquitoes", "HARV", "2026-06", fetch, token="tok"
    )
    assert release == "PROVISIONAL" and set(tables) == {
        "mos_trapping",
        "mos_expertTaxonomistIDProcessed",
    }
    assert "Aedes punctor" in tables["mos_expertTaxonomistIDProcessed"]
    assert fetch_month_tables(
        "ticks",
        "HARV",
        "2026-06",
        lambda u, timeout=120, token=None: json.dumps({"data": {"files": []}}).encode(),
    ) == ({}, "?")


def test_data_months_newest_n_across_sites_capped_at_today():
    """Mutant seen failing: cap removed (a future month '2026-10' leaks in)."""
    sites = [
        {"code": "A", "months": {"ticks": ["2025-03", "2026-05", "2026-10"]}},
        {
            "code": "B",
            "months": {"ticks": ["2026-08", "2026-06"], "mosquitoes": ["2026-08"]},
        },
    ]
    assert data_months(sites, "ticks", dt.date(2026, 9, 12), 3) == [
        "2026-08",
        "2026-06",
        "2026-05",
    ]
    assert data_months(sites, "mosquitoes", dt.date(2026, 9, 12), 12) == ["2026-08"]
    assert data_months(sites, "ticks", dt.date(2025, 1, 1), 12) == []


def test_build_requests_only_available_months_and_aggregates_per_site():
    """Mutants seen failing: `m in s['months'].get(k)` availability check dropped (calls include ('ticks','2026-07'));
    per-site series sort removed (ticks months are fed oldest-first here, so the output order is the sort's doing)."""
    sites = [
        {
            "code": "HARV",
            "name": "Harvard",
            "lat": 42.536911,
            "lon": -72.172658,
            "type": "CORE",
            "months": {"ticks": ["2025-06", "2026-06"], "mosquitoes": ["2026-06"]},
        },
        {
            "code": "NONE",
            "name": "Nothing",
            "lat": 1.0,
            "lon": 2.0,
            "type": "CORE",
            "months": {"ticks": ["2026-06"]},
        },
    ]
    calls = []

    def fm(kind, site, month):
        calls.append((site, kind, month))
        if site == "NONE":
            return {"tck_fielddata": TCK_FIELD.splitlines()[0] + "\n"}, "PROVISIONAL"
        if kind == "ticks":
            return (
                {"tck_fielddata": TCK_FIELD}
                | ({"tck_taxonomyProcessed": TCK_TAXO} if month == "2025-06" else {}),
                "RELEASE-2026" if month == "2025-06" else "PROVISIONAL",
            )
        return {
            "mos_trapping": MOS_TRAP,
            "mos_sorting": MOS_SORT,
            "mos_expertTaxonomistIDProcessed": MOS_TAXO,
        }, "PROVISIONAL"

    months = {
        "ticks": ["2025-06", "2026-06", "2026-07"],
        "mosquitoes": ["2026-07", "2026-06"],
    }
    feats, c = build(sites, months, fm, sleep=0, workers=2)
    assert sorted(calls) == [
        ("HARV", "mosquitoes", "2026-06"),
        ("HARV", "ticks", "2025-06"),
        ("HARV", "ticks", "2026-06"),
        ("NONE", "ticks", "2026-06"),
    ]
    assert c == {
        "sites": 1,
        "site_months": 3,
        "pending": 1,
        "provisional": 2,
        "empty": 1,
        "ticks": 50,
        "mosquitoes": 45,
    }
    assert len(feats) == 1, "a site with no usable months is not emitted"
    p = feats[0]["properties"]
    assert feats[0]["geometry"]["coordinates"] == [-72.17266, 42.53691]
    assert (
        [b["m"] for b in p["ticks"]] == ["2026-06", "2025-06"]
        and p["ticks"][0]["pending"] is True
        and p["ticks"][1]["count"] == 50
    )
    assert p["ticks"][1]["release"] == "RELEASE-2026"
    assert p["mosquitoes"][0]["per_trapnight"] == 45.96
    assert p["stages"] == {"larva": 35, "nymph": 13, "adult": 2}
    assert p["genera"] == {
        "ticks": {"unidentified": 35, "Ixodes": 14, "Dermacentor": 1},
        "mosquitoes": {"Aedes": 34, "Coquillettidia": 11},
    }


def test_main_end_to_end(tmp_path, monkeypatch):
    import pipeline.neon_vectors as m

    monkeypatch.setenv("NEON_TOKEN", "tok")
    monkeypatch.setattr(
        m,
        "fetch_sites",
        lambda fetch=None, token=None: [
            {
                "code": "HARV",
                "name": "Harvard",
                "lat": 1.0,
                "lon": 2.0,
                "type": "CORE",
                "months": {"ticks": ["2026-06"], "mosquitoes": ["2026-06"]},
            }
        ],
    )
    monkeypatch.setattr(
        m,
        "fetch_month_tables",
        lambda k, s, mo, fetch=None, token=None: (
            {"tck_fielddata": TCK_FIELD, "tck_taxonomyProcessed": TCK_TAXO}
            if k == "ticks"
            else {
                "mos_trapping": MOS_TRAP,
                "mos_sorting": MOS_SORT,
                "mos_expertTaxonomistIDProcessed": MOS_TAXO,
            },
            "PROVISIONAL",
        ),
    )
    monkeypatch.setattr(m.time, "sleep", lambda s: None)
    out = tmp_path / "neon-vectors.geojson"
    main(["--out", str(out), "--months", "3", "--today", "2026-09-12"])
    gj = json.loads(out.read_text())
    assert (
        gj["months"] == {"ticks": ["2026-06"], "mosquitoes": ["2026-06"]}
        and len(gj["features"]) == 1
    )
    assert (
        "CC BY 4.0" in gj["source"]["licence"] and gj["source"]["id"] == "neon-vectors"
    )
    assert gj["source"]["products"] == {k: v["code"] for k, v in PRODUCTS.items()}
    assert gj["counts"]["ticks"] == 50 and gj["counts"]["mosquitoes"] == 45
    monkeypatch.delenv("NEON_TOKEN")
    try:
        main(["--out", str(out)])
        assert False
    except RuntimeError as e:
        assert "NEON_TOKEN" in str(e)


def test_get_retries_transport_and_5xx_but_not_4xx(monkeypatch):
    """Mutants seen failing: transport-error `except` branch removed (URLError propagates on the first attempt);
    `e.code < 500` changed to `< 400` (a 404 gets retried instead of raised at once)."""
    import io as _io
    import urllib.error
    import pipeline.neon_vectors as m

    calls = []

    def opener(script):
        it = iter(script)

        def urlopen(req, timeout=120):
            calls.append(req.full_url)
            r = next(it)
            if isinstance(r, Exception):
                raise r
            return r

        return urlopen

    class Ctx(_io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(
        m.urllib.request,
        "urlopen",
        opener([urllib.error.URLError("Network is unreachable"), Ctx(b"ok")]),
    )
    slept = []
    assert m._get("https://x/a", sleep=slept.append) == b"ok" and slept == [5]
    monkeypatch.setattr(
        m.urllib.request,
        "urlopen",
        opener(
            [urllib.error.HTTPError("https://x/b", 503, "busy", {}, None), Ctx(b"ok2")]
        ),
    )
    assert m._get("https://x/b", sleep=lambda s: None) == b"ok2"
    monkeypatch.setattr(
        m.urllib.request,
        "urlopen",
        opener(
            [
                urllib.error.HTTPError("https://x/c", 404, "nope", {}, None),
                Ctx(b"never"),
            ]
        ),
    )
    calls.clear()
    try:
        m._get("https://x/c", sleep=lambda s: None)
        assert False, "404 must raise"
    except urllib.error.HTTPError as e:
        assert e.code == 404 and calls == ["https://x/c"], "no retry on 4xx"


def test_mosquito_summary_warns_when_a_sample_is_split_into_several_subsamples(caplog):
    """Mutant seen failing: removing the split-sample warning. Positive control: the real one-subsample fixture is silent."""
    import logging

    tables = {"mos_trapping": MOS_TRAP, "mos_sorting": MOS_SORT, "mos_expertTaxonomistIDProcessed": MOS_TAXO}
    with caplog.at_level(logging.WARNING, logger="neon_vectors"):
        mosquito_summary(tables)
    assert not [r for r in caplog.records if "more than one sorted subsample" in r.getMessage()]
    split_row = MOS_SORT.strip().splitlines()[1].replace('"s1"', '"s2"').replace(".S.01", ".S.02")
    split = {**tables, "mos_sorting": MOS_SORT + split_row + "\n"}
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="neon_vectors"):
        mosquito_summary(split)
    msgs = [r.getMessage() for r in caplog.records if "more than one sorted subsample" in r.getMessage()]
    assert len(msgs) == 1 and "HARV_077.20260624.0609" in msgs[0]

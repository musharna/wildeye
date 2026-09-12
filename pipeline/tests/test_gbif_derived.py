import json
import pytest
from pipeline.gbif_derived import related_datasets, payload, register, main

GJ = {"window_days": 120, "generated_at": "2026-09-12T00:00:00Z", "taxa": ["a", "b"], "features": [
    {"properties": {"source": "gbif", "dataset_key": "k1"}},
    {"properties": {"source": "gbif", "dataset_key": "k1"}},
    {"properties": {"source": "gbif", "dataset_key": "k2"}},
    {"properties": {"source": "obis", "dataset_key": "o1"}},  # OBIS is not GBIF-registered
    {"properties": {"source": "gbif"}},  # no key
]}


def test_related_datasets_counts_only_gbif_keys():
    assert related_datasets(GJ) == {"k1": 2, "k2": 1}
    assert related_datasets({"features": []}) == {}


def test_payload_shape_and_refusal_when_empty():
    import datetime as dt
    b = payload(GJ, "https://example.org/wildeye", dt.date(2026, 9, 12))
    assert b["relatedDatasets"] == {"k1": 2, "k2": 1} and b["sourceUrl"] == "https://example.org/wildeye"
    assert "snapshot 2026-09-12" in b["title"] and "3 records from 2 datasets" in b["description"]
    with pytest.raises(ValueError):
        payload({"features": [{"properties": {"source": "obis", "dataset_key": "o"}}]}, "https://x")


def test_register_posts_json_with_basic_auth():
    seen = {}

    def post(url, data, headers):
        seen.update(url=url, body=json.loads(data), auth=headers["Authorization"])
        return {"doi": "10.35000/test", "citation": "c"}

    out = register({"title": "t", "relatedDatasets": {"k": 1}}, "u", "p", post)
    assert out["doi"] == "10.35000/test" and seen["url"].endswith("/derivedDataset")
    assert seen["auth"] == "Basic dTpw" and seen["body"]["relatedDatasets"] == {"k": 1}


def test_main_dry_run_never_posts_and_register_records_doi(tmp_path, monkeypatch, capsys):
    src = tmp_path / "occ.geojson"
    src.write_text(json.dumps(GJ))
    import pipeline.gbif_derived as m
    posted = []
    monkeypatch.setattr(m, "register", lambda body, u, p: posted.append(body) or {"doi": "10.35000/abc", "citation": "x"})
    main(["--in", str(src), "--source-url", "https://example.org"])
    assert posted == [] and "2 datasets, 3 records" in capsys.readouterr().out
    monkeypatch.setenv("GBIF_USER", "u"); monkeypatch.setenv("GBIF_PASS", "p")
    rec = tmp_path / "rec.json"
    main(["--in", str(src), "--source-url", "https://example.org", "--register", "--record", str(rec)])
    assert len(posted) == 1 and json.loads(rec.read_text())[0]["doi"] == "10.35000/abc"

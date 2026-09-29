"""pipeline.net.urlopen: the one place pipeline code opens a URL, refusing every scheme but http and https."""

import urllib.request

import pytest

from pipeline import net


def test_urlopen_refuses_non_web_schemes_and_passes_web_ones_through(monkeypatch):
    calls = []

    def fake(url, *args, **kwargs):
        calls.append((url, args, kwargs))
        return "opened"

    # Patched on urllib.request, the way the pipeline tests intercept fetches: net must look it up at call time.
    monkeypatch.setattr(urllib.request, "urlopen", fake)
    # Positive control: http and https go through, a Request object as-is, arguments untouched.
    req = urllib.request.Request(
        "https://api.gbif.org/v1/x", headers={"User-Agent": "t"}
    )
    assert net.urlopen(req, timeout=5) == "opened"
    assert net.urlopen("http://example.org/a", 7) == "opened"
    assert net.urlopen("HTTPS://EXAMPLE.ORG/b") == "opened"
    assert calls == [
        (req, (), {"timeout": 5}),
        ("http://example.org/a", (7,), {}),
        ("HTTPS://EXAMPLE.ORG/b", (), {}),
    ]
    # urllib.request.urlopen would read a local file, or use a custom handler, for these.
    for bad in (
        "file:///etc/passwd",
        urllib.request.Request("file:///etc/passwd"),
        "ftp://example.org/x",
        "data:text/plain,hi",
        "/etc/passwd",
    ):
        with pytest.raises(ValueError, match="not http or https"):
            net.urlopen(bad, timeout=5)
    assert len(calls) == 3, "a refused URL never reaches urllib"

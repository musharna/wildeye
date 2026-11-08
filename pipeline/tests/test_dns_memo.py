import socket
import urllib.request

import pytest

from pipeline import dns_memo


@pytest.fixture(autouse=True)
def fresh():
    dns_memo._memo.clear()
    yield
    dns_memo._memo.clear()
    socket.getaddrinfo = dns_memo._real


def test_a_dropout_after_one_good_lookup_is_served_and_a_new_host_still_raises():
    now, calls, up = [0.0], [], [True]

    def resolver(host, port, *a, **k):
        calls.append(host)
        if not up[0]:
            raise socket.gaierror(-5, "No address associated with hostname")
        return [("ok", host)]

    look = lambda h: dns_memo.lookup(
        h, 443, ttl=300, resolve=resolver, clock=lambda: now[0]
    )  # noqa: E731
    assert look("a.example") == [("ok", "a.example")] and calls == ["a.example"]
    now[0] = 100.0
    assert (
        look("a.example") == [("ok", "a.example")] and len(calls) == 1
    )  # inside the ttl: no lookup
    now[0], up[0] = 400.0, False
    assert (
        look("a.example") == [("ok", "a.example")] and len(calls) == 2
    )  # stale, looked up, failed: last good answer
    with pytest.raises(socket.gaierror, match="No address"):
        look("b.example")  # never resolved: the failure is not hidden
    up[0] = True
    now[0] = 401.0
    assert (
        look("a.example") == [("ok", "a.example")] and len(calls) == 4
    )  # a failed refresh is not cached as fresh


def test_installed_it_resolves_a_real_host_and_a_real_fetch_goes_through_it():
    dns_memo.install()
    assert socket.getaddrinfo(
        "noaa-rap-pds.s3.amazonaws.com", 443
    )  # real lookup through the wrapper
    assert any(k[0][0] == "noaa-rap-pds.s3.amazonaws.com" for k in dns_memo._memo)
    with urllib.request.urlopen(
        "https://noaa-rap-pds.s3.amazonaws.com/", timeout=30
    ) as r:  # nosec B310 - fixed https constant
        assert r.status == 200


def test_install_routes_getaddrinfo_through_the_memo(monkeypatch):
    answers = iter([[("ip1",)], socket.gaierror(-5, "No address associated with hostname")])

    def fake(*a, **k):
        x = next(answers)
        if isinstance(x, Exception):
            raise x
        return x

    monkeypatch.setattr(dns_memo, "_real", fake)
    dns_memo.install(ttl=0.0)  # every call looks up again, so the second one meets the dropout
    assert socket.getaddrinfo("h.example", 443) == [("ip1",)]
    assert socket.getaddrinfo("h.example", 443) == [("ip1",)]  # dropout: served from the memo

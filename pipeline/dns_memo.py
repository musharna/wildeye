"""Remember name lookups inside one long fetch, so a DNS dropout costs nothing for a host already resolved.

What it does: `install()` wraps socket.getaddrinfo for this process. A host's answer is reused for `ttl` seconds; after
that it is looked up again, and if that lookup fails the last good answer is used. A host never resolved still raises.
When to reach for it: a fetch of thousands of requests to a few hosts, on a host whose resolver drops out (this WSL
host's Tailscale MagicDNS, 2026-11-08: 10 of 40 lookups failed and 26 took over 1 s while the uplink ran at 8 MB/s).
What failure looks like: socket.gaierror for a host this process has never resolved, as without it.
Test its answer must pass: pipeline/tests/test_dns_memo.py (a dropout after one good lookup is served; a new host raises).
"""

import socket
import threading
import time

_real = socket.getaddrinfo
_memo: dict = {}
_lock = threading.Lock()


def lookup(*args, ttl: float = 300.0, resolve=None, clock=time.monotonic, **kwargs):
    """getaddrinfo(*args, **kwargs) through the memo."""
    resolve = resolve or _real
    key = (args, tuple(sorted(kwargs.items())))
    with _lock:
        hit = _memo.get(key)
    if hit and clock() - hit[0] < ttl:
        return hit[1]
    try:
        ans = resolve(*args, **kwargs)
    except socket.gaierror:
        if hit:
            return hit[1]
        raise
    with _lock:
        _memo[key] = (clock(), ans)
    return ans


def install(ttl: float = 300.0) -> None:
    """Route this process's getaddrinfo through the memo (idempotent)."""
    socket.getaddrinfo = lambda *a, **k: lookup(*a, ttl=ttl, **k)

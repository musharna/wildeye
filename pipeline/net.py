"""The one place pipeline code opens a URL.

urllib.request.urlopen also opens file:// and other non-web schemes (bandit B310), so a URL built from a response or a config value
could read a local file. Every fetch in pipeline/ and analysis/ goes through urlopen here, which refuses any scheme but http and https.
"""

import urllib.parse
import urllib.request

WEB_SCHEMES = ("http", "https")


def urlopen(url, *args, **kwargs):
    """urllib.request.urlopen for http and https URLs (a str or a Request); ValueError for any other scheme, before anything is opened."""
    full_url = getattr(url, "full_url", url)
    scheme = urllib.parse.urlsplit(full_url).scheme.lower()
    if scheme not in WEB_SCHEMES:
        raise ValueError(
            f"refusing to open {full_url!r}: scheme {scheme!r} is not http or https"
        )
    # Looked up at call time, so a test that patches urllib.request.urlopen still intercepts every fetch.
    return urllib.request.urlopen(url, *args, **kwargs)  # nosec B310 - the scheme is checked to be http or https just above

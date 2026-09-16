"""Celestrak fetch retries on timeout / 5xx."""

from __future__ import annotations

import io
import json
import unittest
from unittest import mock
import urllib.error

from refresh import fetch as fetch_mod


class _Resp:
    def __init__(self, body: bytes, status: int = 200):
        self.status = status
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class TestFetchRetry(unittest.TestCase):
    def test_retries_timeout_then_ok(self):
        payload = [{"NORAD_CAT_ID": 1}]
        body = json.dumps(payload).encode()
        calls = {"n": 0}

        def fake_urlopen(req, timeout=None, context=None):
            calls["n"] += 1
            if calls["n"] < 3:
                raise TimeoutError("timed out")
            return _Resp(body)

        with mock.patch.object(fetch_mod.urllib.request, "urlopen", side_effect=fake_urlopen):
            with mock.patch.object(fetch_mod, "_sleep_backoff"):
                with mock.patch.object(fetch_mod, "FETCH_ATTEMPTS", 5):
                    out = fetch_mod.fetch_gp_json()
        self.assertEqual(out, payload)
        self.assertEqual(calls["n"], 3)

    def test_gives_up_after_attempts(self):
        def always_timeout(req, timeout=None, context=None):
            raise TimeoutError("timed out")

        with mock.patch.object(fetch_mod.urllib.request, "urlopen", side_effect=always_timeout):
            with mock.patch.object(fetch_mod, "_sleep_backoff"):
                with mock.patch.object(fetch_mod, "FETCH_ATTEMPTS", 3):
                    out = fetch_mod.fetch_gp_json()
        self.assertIsNone(out)

    def test_retries_http_503(self):
        payload = [{"NORAD_CAT_ID": 2}]
        body = json.dumps(payload).encode()
        calls = {"n": 0}

        def fake_urlopen(req, timeout=None, context=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise urllib.error.HTTPError(
                    "https://example", 503, "Unavailable", hdrs=None, fp=io.BytesIO(b"")
                )
            return _Resp(body)

        with mock.patch.object(fetch_mod.urllib.request, "urlopen", side_effect=fake_urlopen):
            with mock.patch.object(fetch_mod, "_sleep_backoff"):
                out = fetch_mod.fetch_gp_json()
        self.assertEqual(out, payload)
        self.assertEqual(calls["n"], 2)


if __name__ == "__main__":
    unittest.main()

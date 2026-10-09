"""Celestrak fetch retries, fallbacks, and the no-fresh exit."""

from __future__ import annotations

import io
import json
import os
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock
import urllib.error

from refresh import fetch as fetch_mod
from refresh.__main__ import main
from refresh.dump import dump_sats
from refresh.dump_gp import dump_gp


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
                    out = fetch_mod.fetch_json_list("https://celestrak.example/gp.json")
        self.assertEqual(out, payload)
        self.assertEqual(calls["n"], 3)

    def test_gives_up_after_attempts(self):
        def always_timeout(req, timeout=None, context=None):
            raise TimeoutError("timed out")

        with mock.patch.object(fetch_mod.urllib.request, "urlopen", side_effect=always_timeout):
            with mock.patch.object(fetch_mod, "_sleep_backoff"):
                with mock.patch.object(fetch_mod, "FETCH_ATTEMPTS", 3):
                    out = fetch_mod.fetch_json_list("https://celestrak.example/gp.json")
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
                out = fetch_mod.fetch_json_list("https://celestrak.example/gp.json")
        self.assertEqual(out, payload)
        self.assertEqual(calls["n"], 2)


_OMM = {
    "OBJECT_NAME": "STARLINK-1008",
    "NORAD_CAT_ID": 44714,
    "EPOCH": "2026-10-09T06:44:36.190752",
    "MEAN_MOTION": 15.62915731,
    "ECCENTRICITY": 0.00037061,
    "INCLINATION": 53.1488,
    "RA_OF_ASC_NODE": 60.05,
    "ARG_OF_PERICENTER": 90.9958,
    "MEAN_ANOMALY": 269.1481,
    "BSTAR": 1.2e-4,
    "MEAN_MOTION_DOT": 3.1e-5,
}


def _one_url(url: str = "https://celestrak.example/gp.json"):
    return mock.patch.object(fetch_mod, "gp_source_urls", return_value=(url,))


class TestFetchFallback(unittest.TestCase):
    def test_dead_source_budget_stays_under_three_minutes(self):
        self.assertLessEqual(fetch_mod.FETCH_TIMEOUT_S, 30)
        self.assertLessEqual(fetch_mod.FETCH_ATTEMPTS, 2)
        self.assertLessEqual(sum(fetch_mod.BACKOFF_S), 5)
        urls = fetch_mod.GP_URLS
        self.assertTrue(urls[0].startswith("https://"))
        self.assertIn(
            "http://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json",
            urls,
        )
        attempts = fetch_mod.FETCH_ATTEMPTS + fetch_mod.FALLBACK_ATTEMPTS * (len(urls) - 1)
        budget = attempts * fetch_mod.FETCH_TIMEOUT_S + sum(fetch_mod.BACKOFF_S)
        self.assertLess(budget, 180)

    def test_https_timeout_uses_http_once(self):
        body = json.dumps([_OMM]).encode()
        seen: list[str] = []

        def fake_urlopen(req, timeout=None, context=None):
            seen.append(req.full_url)
            if req.full_url.startswith("https:"):
                raise TimeoutError("timed out")
            return _Resp(body)

        urls = (
            "https://celestrak.example/gp.php?GROUP=starlink&FORMAT=json",
            "http://celestrak.example/gp.php?GROUP=starlink&FORMAT=json",
            "http://celestrak.example/sup-gp.php?FILE=starlink&FORMAT=json",
        )
        with mock.patch.object(fetch_mod, "gp_source_urls", return_value=urls):
            with mock.patch.object(fetch_mod.urllib.request, "urlopen", side_effect=fake_urlopen):
                with mock.patch.object(fetch_mod, "_sleep_backoff") as slept:
                    with mock.patch.dict(os.environ, {"STARLINK_MIN_RECORDS": "1"}):
                        out = fetch_mod.fetch_gp_json()
        self.assertEqual(out, [_OMM])
        # Primary is retried once; the HTTP mirror is fetched once; supplemental is not.
        self.assertEqual(seen, [urls[0], urls[0], urls[1]])
        self.assertEqual(slept.call_count, 1)

    def test_stops_at_first_good_source(self):
        body = json.dumps([_OMM]).encode()
        seen: list[str] = []

        def fake_urlopen(req, timeout=None, context=None):
            seen.append(req.full_url)
            return _Resp(body)

        urls = (
            "https://celestrak.example/gp.json",
            "http://celestrak.example/gp.json",
        )
        with mock.patch.object(fetch_mod, "gp_source_urls", return_value=urls):
            with mock.patch.object(fetch_mod.urllib.request, "urlopen", side_effect=fake_urlopen):
                with mock.patch.dict(os.environ, {"STARLINK_MIN_RECORDS": "1"}):
                    out = fetch_mod.fetch_gp_json()
        self.assertEqual(out, [_OMM])
        self.assertEqual(seen, [urls[0]])

    def test_schema_break_is_a_hard_failure(self):
        body = json.dumps([{"error": "nope"}]).encode()

        def fake_urlopen(req, timeout=None, context=None):
            return _Resp(body)

        with _one_url():
            with mock.patch.object(fetch_mod.urllib.request, "urlopen", side_effect=fake_urlopen):
                with self.assertRaises(SystemExit) as raised:
                    fetch_mod.fetch_gp_json()
        self.assertIn("corrupt GP JSON", str(raised.exception))

    def test_too_small_catalog_is_not_published(self):
        body = json.dumps([_OMM]).encode()

        def fake_urlopen(req, timeout=None, context=None):
            return _Resp(body)

        with _one_url():
            with mock.patch.object(fetch_mod.urllib.request, "urlopen", side_effect=fake_urlopen):
                with mock.patch.dict(os.environ, {"STARLINK_MIN_RECORDS": "1000"}):
                    out = fetch_mod.fetch_gp_json()
        self.assertIsNone(out)

    def test_stations_https_timeout_falls_back_to_http(self):
        body = json.dumps([{"NORAD_CAT_ID": 25544, "OBJECT_NAME": "ISS (ZARYA)"}]).encode()
        seen: list[str] = []

        def fake_urlopen(req, timeout=None, context=None):
            seen.append(req.full_url)
            if req.full_url.startswith("https:"):
                raise TimeoutError("timed out")
            return _Resp(body)

        urls = (
            "https://celestrak.example/gp.php?GROUP=stations&FORMAT=json",
            "http://celestrak.example/gp.php?GROUP=stations&FORMAT=json",
        )
        with mock.patch.object(fetch_mod, "stations_source_urls", return_value=urls):
            with mock.patch.object(fetch_mod.urllib.request, "urlopen", side_effect=fake_urlopen):
                out = fetch_mod.fetch_stations_json()
        self.assertEqual(len(out), 1)
        self.assertEqual(seen, list(urls))


class _QuietHandler(BaseHTTPRequestHandler):
    body = b"[]"

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, fmt, *args):
        return


class TestFetchCli(unittest.TestCase):
    def test_unreachable_url_exits_no_fresh_and_writes_nothing(self):
        with TemporaryDirectory() as td:
            env = {
                "STARLINK_CACHE": td,
                "STARLINK_GP_URLS": "http://127.0.0.1:9/starlink.json",
                "STARLINK_FETCH_ATTEMPTS": "1",
                "STARLINK_FETCH_TIMEOUT": "2",
                "STARLINK_MIN_RECORDS": "1",
            }
            buf = io.StringIO()
            with mock.patch.dict(os.environ, env, clear=False):
                with redirect_stdout(buf):
                    code = main(["fetch"])
            self.assertEqual(code, fetch_mod.EXIT_NO_FRESH)
            self.assertIn("no fresh data today, kept previous", buf.getvalue())
            self.assertFalse((Path(td) / "starlink_gp.json").exists())

    def test_local_success_is_reused_by_dump_without_a_second_fetch(self):
        hits = {"n": 0}
        body = json.dumps([_OMM]).encode()

        class Handler(_QuietHandler):
            def do_GET(self):
                hits["n"] += 1
                self.body = body
                super().do_GET()

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as td:
                cache = Path(td) / "cache"
                copy = Path(td) / "copy" / "starlink_gp.json"
                timeline = Path(td) / "timeline"
                timeline.mkdir()
                env = {
                    "STARLINK_CACHE": str(cache),
                    "STARLINK_GP_URLS": f"http://127.0.0.1:{port}/gp.json",
                    "STARLINK_FETCH_ATTEMPTS": "1",
                    "STARLINK_MIN_RECORDS": "1",
                }
                buf = io.StringIO()
                with mock.patch.dict(os.environ, env, clear=False):
                    with redirect_stdout(buf):
                        code = main(["fetch", "--cache-copy", str(copy)])
                    self.assertEqual(code, 0, buf.getvalue())
                    self.assertEqual(hits["n"], 1)
                    cached = json.loads((cache / "starlink_gp.json").read_text(encoding="utf-8"))
                    self.assertEqual(cached[0]["NORAD_CAT_ID"], 44714)
                    self.assertEqual(json.loads(copy.read_text(encoding="utf-8")), cached)

                    def explode(req, timeout=None, context=None):
                        raise AssertionError(f"unexpected second fetch {req.full_url}")

                    with mock.patch.object(
                        fetch_mod.urllib.request, "urlopen", side_effect=explode
                    ):
                        payload = dump_sats(
                            Path(td) / "sats.json",
                            timeline_dir=timeline,
                            frame_date=date(2026, 10, 9),
                        )
                        gp_payload = dump_gp(
                            Path(td) / "gp.json",
                            starlink_path=cache / "starlink_gp.json",
                            stations_path=Path(td) / "missing-stations.json",
                            fetch_missing=False,
                        )
                self.assertEqual(hits["n"], 1)
                self.assertEqual(payload["n"], 1)
                self.assertEqual(gp_payload["n"], 1)
                self.assertIn("GP JSON fetched from", buf.getvalue())
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_corrupt_payload_exits_1(self):
        body = json.dumps([{"error": "nope"}]).encode()

        class Handler(_QuietHandler):
            def do_GET(self):
                self.body = body
                super().do_GET()

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as td:
                env = {
                    "STARLINK_CACHE": td,
                    "STARLINK_GP_URLS": f"http://127.0.0.1:{port}/gp.json",
                    "STARLINK_FETCH_ATTEMPTS": "1",
                    "STARLINK_MIN_RECORDS": "1",
                }
                err = io.StringIO()
                with mock.patch.dict(os.environ, env, clear=False):
                    with redirect_stderr(err):
                        code = main(["fetch"])
                self.assertEqual(code, 1)
                self.assertIn("corrupt GP JSON", err.getvalue())
                self.assertFalse((Path(td) / "starlink_gp.json").exists())
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_corrupt_cache_fails_dump(self):
        with TemporaryDirectory() as td:
            cache = Path(td) / "cache"
            cache.mkdir()
            (cache / "starlink_gp.json").write_text("{", encoding="utf-8")
            with mock.patch.dict(os.environ, {"STARLINK_CACHE": str(cache)}):
                with self.assertRaises(SystemExit) as raised:
                    dump_sats(
                        Path(td) / "sats.json",
                        timeline_dir=Path(td) / "timeline",
                        frame_date=date(2026, 10, 9),
                    )
            self.assertIn("corrupt GP cache", str(raised.exception))

    def test_workflow_soft_fail_and_node24_actions(self):
        root = Path(__file__).resolve().parents[2]
        text = (root / ".github/workflows/starlink-refresh.yml").read_text(encoding="utf-8")
        self.assertIn("actions/checkout@v5", text)
        self.assertIn("actions/setup-python@v6", text)
        self.assertIn("actions/cache@v5", text)
        self.assertNotIn("actions/checkout@v4", text)
        self.assertNotIn("actions/setup-python@v5", text)
        self.assertIn("python3 -m refresh fetch", text)
        self.assertIn('"$code" -eq 3', text)
        self.assertIn("::warning::no fresh data today, kept previous", text)
        self.assertIn("no fresh data today, kept previous", text)
        # runner is illegal in jobs.<job_id>.env and fails the file before any job starts.
        job_env = text.split("jobs:", 1)[1].split("steps:", 1)[0]
        self.assertNotIn("runner.", job_env)
        dump = text.split("- name: Dump sats.json", 1)[1]
        self.assertIn("STARLINK_CACHE: ${{ runner.temp }}/starlink", dump)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Regression tests for the Whisper Model Installer extension.

Covers cache-dir resolution precedence, filename sanitization, install-state
detection against a fake cache tree, and the download/job lifecycle with the
HTTP layer monkeypatched to fixtures - no network needed.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path

# Never leave __pycache__ bytecode inside the extension tree - it must not end
# up in a published artifact zip.
sys.dont_write_bytecode = True

REPO_ROOT = Path(__file__).resolve().parents[1]
SIDECAR_DIR = REPO_ROOT / "extensions" / "whisper-model-installer" / "sidecar"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# Load hf_cache under its own module name FIRST so routes_impl's plain
# ``import hf_cache`` resolves to this exact module object - otherwise the
# patches below (resolve_cache_dir, urlopen) would hit a second copy and the
# tests would silently probe the real user cache.
sys.path.insert(0, str(SIDECAR_DIR))
hf_cache = _load("hf_cache", SIDECAR_DIR / "hf_cache.py")
routes_impl = _load("whisper_model_installer_routes", SIDECAR_DIR / "routes_impl.py")
sys.path.pop(0)

FAKE_SHA = "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"


class _FakeResponse:
    """Minimal response object for the patched urlopen."""

    def __init__(self, body: bytes, headers: dict):
        self._body = body
        self.headers = headers

    def read(self, n: int = -1):
        if n is None or n < 0:
            chunk, self._body = self._body, b""
        else:
            chunk, self._body = self._body[:n], self._body[n:]
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _patch_http(files: dict, sizes: dict, calls: list):
    """Patch urllib.request.urlopen to serve fixture bodies keyed by URL."""
    def fake_urlopen(req, timeout=None, context=None):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        if url.endswith("/api/models/Systran/faster-whisper-base"):
            siblings = [{"rfilename": n} for n in list(files) + ["README.md", ".gitattributes"]]
            calls.append(url)
            return _FakeResponse(
                json.dumps({"sha": FAKE_SHA, "siblings": siblings}).encode(),
                {"Content-Type": "application/json"},
            )
        for name, body in files.items():
            if url.endswith(f"/resolve/main/{name}"):
                if req.get_method() == "HEAD":
                    return _FakeResponse(b"", {"Content-Length": str(len(body))})
                calls.append(url)
                headers = {
                    "Content-Length": str(len(body)),
                    "ETag": f'"fake-etag-{name}"',
                }
                return _FakeResponse(body, headers)
        raise urllib.error.URLError(f"unexpected url {url}")

    return fake_urlopen


class CacheDirResolutionTests(unittest.TestCase):
    def tearDown(self) -> None:
        for var in ("HF_HUB_CACHE", "HF_HOME"):
            os.environ.pop(var, None)

    def test_explicit_hub_cache_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["HF_HUB_CACHE"] = tmp
            os.environ["HF_HOME"] = tmp + "/hfhome"
            self.assertEqual(str(hf_cache.resolve_cache_dir()), tmp)

    def test_hf_home_hub_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ.pop("HF_HUB_CACHE", None)
            os.environ["HF_HOME"] = tmp
            self.assertEqual(
                hf_cache.resolve_cache_dir(), Path(tmp).expanduser() / "hub"
            )

    def test_default_is_dot_cache(self):
        os.environ.pop("HF_HUB_CACHE", None)
        os.environ.pop("HF_HOME", None)
        self.assertEqual(
            hf_cache.resolve_cache_dir(),
            Path.home() / ".cache" / "huggingface" / "hub",
        )


class FilenameSanitizationTests(unittest.TestCase):
    def test_accepts_plain_files(self):
        for name in hf_cache.REQUIRED_FILES:
            self.assertTrue(hf_cache._valid_filename(name))

    def test_rejects_traversal_and_weird_names(self):
        for bad in (
            "../etc/passwd",
            "..\\windows",
            "a/b",
            "a:b",
            ".",
            "..",
            " spaced ",
            "",
            "x" * 129,
            "name\x00null",
        ):
            self.assertFalse(hf_cache._valid_filename(bad), bad)


class InstallStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cache = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def _write_installed(self):
        base = hf_cache.repo_cache_path(self.cache)
        snap = base / "snapshots" / FAKE_SHA
        snap.mkdir(parents=True)
        for f in hf_cache.REQUIRED_FILES:
            (snap / f).write_bytes(b"x")
        (base / "refs").mkdir(parents=True, exist_ok=True)
        (base / "refs" / "main").write_text(FAKE_SHA + "\n", encoding="utf-8")

    def test_empty_cache_is_not_installed(self):
        state = hf_cache.install_state(self.cache)
        self.assertFalse(state["installed"])
        self.assertEqual(state["missing_files"], hf_cache.REQUIRED_FILES)
        self.assertEqual(state["cache_dir"], str(self.cache))

    def test_complete_snapshot_is_installed(self):
        self._write_installed()
        state = hf_cache.install_state(self.cache)
        self.assertTrue(state["installed"])
        self.assertEqual(state["revision"], FAKE_SHA)
        self.assertIn("snapshots", state["snapshot_path"])

    def test_missing_file_is_reported(self):
        self._write_installed()
        (hf_cache.repo_cache_path(self.cache) / "snapshots" / FAKE_SHA / "model.bin").unlink()
        state = hf_cache.install_state(self.cache)
        self.assertFalse(state["installed"])
        self.assertEqual(state["missing_files"], ["model.bin"])


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cache = Path(self.temp.name)
        self.files = {
            "config.json": b'{"model_type": "whisper"}',
            "model.bin": b"\x00" * 4096,
            "tokenizer.json": b'{"version": "1.0"}',
            "vocabulary.txt": b"a 1\nb 2\n",
        }
        self.calls: list = []
        self._saved_urlopen = hf_cache.urllib.request.urlopen

    def tearDown(self):
        hf_cache.urllib.request.urlopen = self._saved_urlopen
        self.temp.cleanup()

    def _patch(self):
        hf_cache.urllib.request.urlopen = _patch_http(self.files, {}, self.calls)

    def test_download_writes_standard_layout(self):
        self._patch()
        result = hf_cache.download_model(cache_dir=self.cache)
        self.assertFalse(result["already_installed"])
        self.assertEqual(result["revision"], FAKE_SHA)
        base = hf_cache.repo_cache_path(self.cache)
        self.assertEqual(
            (base / "refs" / "main").read_text(encoding="utf-8").strip(), FAKE_SHA
        )
        snap = base / "snapshots" / FAKE_SHA
        for name, body in self.files.items():
            target = snap / name
            self.assertTrue(target.is_file(), name)
            if target.is_symlink():
                self.assertEqual(target.read_bytes(), body)  # follows the link
            else:
                self.assertEqual(target.read_bytes(), body)
        # blobs are named by etag per huggingface_hub convention
        blobs = list((base / "blobs").glob("fake-etag-*"))
        self.assertEqual(len(blobs), len(self.files))
        self.assertTrue(hf_cache.install_state(self.cache)["installed"])

    def test_second_run_is_noop_when_installed(self):
        self._patch()
        hf_cache.download_model(cache_dir=self.cache)
        calls_before = len(self.calls)
        result = hf_cache.download_model(cache_dir=self.cache)
        self.assertTrue(result["already_installed"])
        # only the metadata API call repeats; no file downloads
        self.assertEqual(len(self.calls), calls_before + 1)

    def test_cancel_between_files(self):
        self._patch()
        cancel = threading.Event()

        real_read = _FakeResponse.read

        def read_and_cancel(self_resp, n=-1):
            chunk = real_read(self_resp, n)
            cancel.set()  # cancel as soon as the first file starts streaming
            return chunk

        _FakeResponse.read = read_and_cancel
        try:
            with self.assertRaises(hf_cache.InstallError) as ctx:
                hf_cache.download_model(cache_dir=self.cache, cancel=cancel)
        finally:
            _FakeResponse.read = real_read
        self.assertEqual(str(ctx.exception), "canceled")
        base = hf_cache.repo_cache_path(self.cache)
        self.assertFalse((base / "refs" / "main").exists())
        # partial blob tmp was cleaned up
        self.assertEqual(list((base / "blobs").glob(".*")), [])
        self.assertFalse(hf_cache.install_state(self.cache)["installed"])

    def test_missing_remote_file_fails_loudly(self):
        def fake_urlopen(req, timeout=None, context=None):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            if url.endswith("/api/models/Systran/faster-whisper-base"):
                siblings = [{"rfilename": n} for n in self.files if n != "model.bin"]
                return _FakeResponse(
                    json.dumps({"sha": FAKE_SHA, "siblings": siblings}).encode(),
                    {"Content-Type": "application/json"},
                )
            raise urllib.error.URLError(url)

        hf_cache.urllib.request.urlopen = fake_urlopen
        with self.assertRaises(hf_cache.InstallError) as ctx:
            hf_cache.download_model(cache_dir=self.cache)
        self.assertIn("model.bin", str(ctx.exception))

    def test_truncated_download_detected(self):
        def fake_urlopen(req, timeout=None, context=None):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            if url.endswith("/api/models/Systran/faster-whisper-base"):
                siblings = [{"rfilename": n} for n in self.files]
                return _FakeResponse(
                    json.dumps({"sha": FAKE_SHA, "siblings": siblings}).encode(),
                    {"Content-Type": "application/json"},
                )
            for name, body in self.files.items():
                if url.endswith(f"/resolve/main/{name}"):
                    truncated = body[: len(body) // 2]
                    if req.get_method() == "HEAD":
                        return _FakeResponse(b"", {"Content-Length": str(len(body))})
                    # lie about the length -> truncation must be detected
                    return _FakeResponse(
                        truncated, {"Content-Length": str(len(body)), "ETag": f'"e-{name}"'}
                    )
            raise urllib.error.URLError(url)

        hf_cache.urllib.request.urlopen = fake_urlopen
        with self.assertRaises(hf_cache.InstallError) as ctx:
            hf_cache.download_model(cache_dir=self.cache)
        self.assertIn("truncated", str(ctx.exception))


class _FakeApp:
    """Route recorder standing in for the canonical Sidecar scaffold."""

    def __init__(self):
        self.routes = {}

    def route(self, method, path):
        def deco(fn):
            self.routes[(method, path)] = fn
            return fn

        return deco

    @staticmethod
    def json(obj, status=200):
        return status, {}, json.dumps(obj).encode("utf-8")


class JobLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cache = Path(self.temp.name)
        self._saved_cache = hf_cache.resolve_cache_dir
        hf_cache.resolve_cache_dir = lambda: self.cache
        self.app = _FakeApp()
        routes_impl.register(self.app)
        self._saved_urlopen = hf_cache.urllib.request.urlopen
        self._files = {
            "config.json": b"{}",
            "model.bin": b"\x01" * 2048,
            "tokenizer.json": b"{}",
            "vocabulary.txt": b"a 1\n",
        }
        self.calls = []
        hf_cache.urllib.request.urlopen = _patch_http(self._files, {}, self.calls)

    def tearDown(self):
        hf_cache.resolve_cache_dir = self._saved_cache
        hf_cache.urllib.request.urlopen = self._saved_urlopen
        self.temp.cleanup()

    def _wait_terminal(self, timeout=10.0):
        import time

        deadline = time.time() + timeout
        while time.time() < deadline:
            status, _, body = self.app.routes[("GET", "/api/install")](None)
            payload = json.loads(body)
            if payload["state"] in ("done", "error", "canceled"):
                return payload
            time.sleep(0.02)
        self.fail("job never reached a terminal state")

    def test_register_wires_all_routes(self):
        for route in (
            ("GET", "/api/status"),
            ("POST", "/api/install"),
            ("GET", "/api/install"),
            ("POST", "/api/install/cancel"),
        ):
            self.assertIn(route, self.app.routes)

    def test_install_job_completes(self):
        status, _, body = self.app.routes[("POST", "/api/install")](None)
        self.assertEqual(status, 200)
        self.assertIn("job_id", json.loads(body))
        payload = self._wait_terminal()
        self.assertEqual(payload["state"], "done")
        self.assertEqual(payload["progress"]["files_done"], len(self._files))
        self.assertEqual(payload["error"], "")

        status, _, body = self.app.routes[("GET", "/api/status")](None)
        self.assertTrue(json.loads(body)["install"]["installed"])

    def test_second_install_while_running_is_409(self):
        status, _, body = self.app.routes[("POST", "/api/install")](None)
        self.assertEqual(status, 200)
        status2, _, body2 = self.app.routes[("POST", "/api/install")](None)
        self.assertEqual(status2, 409)
        self._wait_terminal()

    def test_cancel_request_sets_flag(self):
        self.app.routes[("POST", "/api/install")](None)
        status, _, body = self.app.routes[("POST", "/api/install/cancel")](None)
        self.assertIn(json.loads(body)["state"], ("canceling", "canceled", "done"))
        self._wait_terminal()

    def test_status_reports_empty_cache(self):
        status, _, body = self.app.routes[("GET", "/api/status")](None)
        payload = json.loads(body)
        self.assertFalse(payload["install"]["installed"])
        self.assertEqual(payload["model"]["repo_id"], hf_cache.REPO_ID)
        self.assertEqual(payload["mirror"], hf_cache.DEFAULT_MIRROR)


if __name__ == "__main__":
    unittest.main(verbosity=2)

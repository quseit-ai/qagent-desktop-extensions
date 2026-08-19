"""Whisper Model Installer - downloads the faster-whisper-base model from the
hf-mirror.com mirror into the default Hugging Face cache directory.

Stdlib only (the sidecar runs under ``python3 -S``; no huggingface_hub).

Cache layout written (compatible with ``huggingface_hub``'s
``snapshot_download`` for the common offline path):

    <cache>/models--Systran--faster-whisper-base/
        blobs/<etag>                 raw file content (atomic tmp + rename)
        snapshots/<commit_sha>/<f>   symlink to ../../blobs/<etag> (copy on
                                     win32, which is what huggingface_hub does)
        refs/main                    the commit sha, atomically replaced

Cache-dir resolution matches huggingface_hub:
``HF_HUB_CACHE`` -> ``$HF_HOME/hub`` -> ``~/.cache/huggingface/hub``.
``HF_ENDPOINT`` overrides the mirror (default https://hf-mirror.com).

Downloads are cancelable between chunk reads and resume-safe per file: each
blob is written to a tmp name and atomically renamed, so a re-run starts clean
per file (a completed blob is only re-downloaded when its snapshot entry is
missing).
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import ssl
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

REPO_ID = "Systran/faster-whisper-base"
REPO_DIR_NAME = "models--Systran--faster-whisper-base"
DEFAULT_MIRROR = "https://hf-mirror.com"
# The repo's real file list (verified against <mirror>/api/models/Systran/
# faster-whisper-base). README.md and .gitattributes are not needed to run
# the model and are intentionally not downloaded.
REQUIRED_FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"]

_READ_CHUNK = 256 * 1024
_FETCH_TIMEOUT = 60  # per socket op; big files stream many small reads
_USER_AGENT = "hermes-ext-whisper-model-installer/0.1"


class InstallError(Exception):
    """A download/installation failure with a user-presentable message."""


def mirror_base_url() -> str:
    raw = os.getenv("HF_ENDPOINT", DEFAULT_MIRROR).strip().rstrip("/")
    if not (raw.startswith("https://") or raw.startswith("http://")):
        return DEFAULT_MIRROR
    return raw


def resolve_cache_dir() -> Path:
    """huggingface_hub-compatible default cache dir resolution."""
    explicit = os.getenv("HF_HUB_CACHE")
    if explicit:
        return Path(explicit).expanduser()
    home = os.getenv("HF_HOME")
    if home:
        return Path(home).expanduser() / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def repo_cache_path(cache_dir: Optional[Path] = None) -> Path:
    base = resolve_cache_dir() if cache_dir is None else Path(cache_dir)
    return base / REPO_DIR_NAME


def _valid_filename(name: str) -> bool:
    """Every sibling we act on must be a plain top-level filename - no path
    traversal, no separators, nothing the remote API could smuggle in."""
    if not name or name in (".", ".."):
        return False
    if "/" in name or "\\" in name or ":" in name:
        return False
    if name != name.strip() or len(name) > 128:
        return False
    return all(ch.isalnum() or ch in "._-" for ch in name)


def install_state(cache_dir: Optional[Path] = None) -> Dict:
    """Cheap local check (no network): is the model already in the cache?"""
    base = repo_cache_path(cache_dir)
    refs = base / "refs" / "main"
    sha = ""
    if refs.is_file():
        try:
            sha = refs.read_text(encoding="utf-8").strip()
        except OSError:
            sha = ""
    snapshot = base / "snapshots" / sha if sha else None
    if snapshot and snapshot.is_dir():
        missing = [f for f in REQUIRED_FILES if not (snapshot / f).is_file()]
    else:
        missing = list(REQUIRED_FILES)
    return {
        "installed": bool(sha) and not missing,
        "revision": sha,
        "snapshot_path": str(snapshot) if snapshot and snapshot.is_dir() else "",
        "missing_files": missing,
        "cache_dir": str(resolve_cache_dir() if cache_dir is None else Path(cache_dir)),
    }


def _http_open(url: str):
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    return urllib.request.urlopen(req, timeout=_FETCH_TIMEOUT, context=ctx)


def fetch_repo_info() -> Dict:
    """{sha, files} from the mirror's model API. The install fails loudly if
    any REQUIRED_FILE is absent from the repo rather than silently skipping."""
    url = f"{mirror_base_url()}/api/models/{REPO_ID}"
    try:
        with _http_open(url) as resp:
            payload = resp.read(2 * 1024 * 1024)
        info = json.loads(payload.decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise InstallError(f"cannot reach {mirror_base_url()} for model info: {exc}") from exc
    sha = str(info.get("sha") or "").strip()
    names: List[str] = []
    for sib in info.get("siblings") or []:
        name = sib.get("rfilename") if isinstance(sib, dict) else None
        if isinstance(name, str) and _valid_filename(name):
            names.append(name)
    missing = [f for f in REQUIRED_FILES if f not in names]
    if missing:
        raise InstallError(
            f"mirror repo {REPO_ID} is missing expected files: {', '.join(missing)}"
        )
    if not sha or len(sha) > 64:
        raise InstallError(f"mirror repo {REPO_ID} returned an unusable revision id")
    return {"sha": sha, "files": list(REQUIRED_FILES)}


def _blob_name_from_headers(headers, digest: str) -> str:
    """Prefer the ETag (what huggingface_hub names blobs by); fall back to the
    content sha256 computed while streaming. Quote-wrapped weak/strong etags
    are stripped."""
    etag = headers.get("X-Linked-Etag") or headers.get("ETag") or ""
    etag = etag.strip().lstrip("W/").strip().strip('"')
    if etag and len(etag) <= 128 and all(ch.isalnum() or ch in "._-" for ch in etag):
        return etag
    return digest


def _link_or_copy(blob_path: Path, snapshot_file: Path) -> None:
    """huggingface_hub behavior: relative symlink on POSIX, real copy on
    Windows (symlinks need privileges there)."""
    if snapshot_file.is_symlink() or snapshot_file.exists():
        snapshot_file.unlink()
    if os.name == "nt":
        shutil.copyfile(blob_path, snapshot_file)
    else:
        snapshot_file.symlink_to(os.path.join("..", "..", "blobs", blob_path.name))


def _probe_size(name: str) -> Optional[int]:
    """Best-effort HEAD to learn a file's size up front so the UI can show a
    byte-accurate total before the first byte lands."""
    url = f"{mirror_base_url()}/{REPO_ID}/resolve/main/{name}"
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": _USER_AGENT})
        with urllib.request.urlopen(req, timeout=_FETCH_TIMEOUT) as resp:
            size = resp.headers.get("X-Linked-Size") or resp.headers.get("Content-Length")
        return int(size) if size and size.isdigit() else None
    except (urllib.error.URLError, OSError, ValueError):
        return None  # best-effort; the GET stream still works without it


def _cleanup(tmp_path: Path) -> None:
    try:
        tmp_path.unlink()
    except OSError:
        pass


def download_model(
    cache_dir: Optional[Path] = None,
    progress: Optional[Dict] = None,
    cancel: Optional[threading.Event] = None,
) -> Dict:
    """Download all REQUIRED_FILES into the standard HF cache layout.

    ``progress`` (if given) is updated in place - its keys match the job status
    payload the routes serve (files_done, current_file, downloaded_bytes,
    total_bytes, total_known). Raises InstallError on failure or cancel; a
    partial blob is removed, so nothing half-written is ever exposed.
    """
    cache = Path(cache_dir) if cache_dir else resolve_cache_dir()
    info = fetch_repo_info()
    sha = info["sha"]

    state = install_state(cache)
    if state["installed"] and state["revision"] == sha:
        return {"already_installed": True, "revision": sha, "snapshot_path": state["snapshot_path"]}

    base = repo_cache_path(cache)
    snapshot_dir = base / "snapshots" / sha
    (base / "blobs").mkdir(parents=True, exist_ok=True)
    snapshot_dir.mkdir(parents=True, exist_ok=True)

    sizes = {name: _probe_size(name) for name in REQUIRED_FILES}
    total_bytes = sum(s for s in sizes.values() if s)
    if progress is not None:
        progress["total_bytes"] = total_bytes
        progress["total_known"] = total_bytes > 0

    downloaded_bytes = 0
    for name in REQUIRED_FILES:
        if cancel is not None and cancel.is_set():
            raise InstallError("canceled")
        if progress is not None:
            progress["current_file"] = name
        url = f"{mirror_base_url()}/{REPO_ID}/resolve/main/{name}"
        expected = sizes.get(name)
        snapshot_file = snapshot_dir / name
        tmp_path = base / "blobs" / f".{name}.tmp"
        try:
            with _http_open(url) as resp:
                headers = resp.headers
                length_header = headers.get("Content-Length")
                length = int(length_header) if length_header and length_header.isdigit() else None
                if expected is not None and length is not None and length != expected:
                    raise InstallError(
                        f"{name}: size changed on the mirror mid-install "
                        f"({length} != {expected}); retry"
                    )
                digest = hashlib.sha256()
                got = 0
                with open(tmp_path, "wb") as out:
                    while True:
                        if cancel is not None and cancel.is_set():
                            raise InstallError("canceled")
                        chunk = resp.read(_READ_CHUNK)
                        if not chunk:
                            break
                        out.write(chunk)
                        digest.update(chunk)
                        got += len(chunk)
                        downloaded_bytes += len(chunk)
                        if progress is not None:
                            progress["downloaded_bytes"] = downloaded_bytes
                if length is not None and got != length:
                    raise InstallError(
                        f"{name}: truncated download ({got} of {length} bytes)"
                    )
            blob_name = _blob_name_from_headers(headers, digest.hexdigest())
            blob_path = base / "blobs" / blob_name
            os.replace(tmp_path, blob_path)
            _link_or_copy(blob_path, snapshot_file)
        except InstallError:
            _cleanup(tmp_path)
            raise
        except (urllib.error.URLError, OSError) as exc:
            _cleanup(tmp_path)
            raise InstallError(f"downloading {name} from {mirror_base_url()}: {exc}") from exc
        if progress is not None:
            progress["files_done"] = progress.get("files_done", 0) + 1

    refs = base / "refs"
    refs.mkdir(parents=True, exist_ok=True)
    refs_tmp = refs / ".main.tmp"
    refs_tmp.write_text(sha + "\n", encoding="utf-8")
    os.replace(refs_tmp, refs / "main")
    return {"already_installed": False, "revision": sha, "snapshot_path": str(snapshot_dir)}

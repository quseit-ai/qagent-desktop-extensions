"""Route implementations for the whisper-model-installer sidecar.

This is the ONLY file this extension authors on top of the canonical scaffold
(besides hf_cache.py, its imported helper). Auth is handled entirely by
``sidecar_base.py`` - every route here is reachable only with a valid
WebUI-injected ``X-Hermes-Sidecar-Token`` (deny-by-default); ``/health`` (owned
by the scaffold) is the sole tokenless route.

Routes (proxied at /api/extensions/whisper-model-installer/sidecar/...):
  GET  /api/status          - model catalog + local install state (no network)
  POST /api/install         - start the background download job -> {job_id}
  GET  /api/install         - job progress {state, files_done, ...} (poll me)
  POST /api/install/cancel  - request cancellation of a running job

A ~145 MB model download far outlives the ~10 s proxy timeout, so the install
is a start-job + poll pair (docs/SIDECAR_CONTRACT.md), never a held request.
"""
from __future__ import annotations

import threading
import time
import uuid

import hf_cache

# Single-flight job store: one install at a time (the model is fixed, so
# concurrent installs would only race on the same blobs).
_jobs: dict = {"current": None}
_jobs_lock = threading.Lock()


def _new_job() -> dict:
    return {
        "job_id": uuid.uuid4().hex[:16],
        "state": "running",  # running | done | error | canceled
        "started_at": time.time(),
        "finished_at": None,
        "progress": {
            "files_done": 0,
            "files_total": len(hf_cache.REQUIRED_FILES),
            "current_file": "",
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "total_known": False,
        },
        "result": None,
        "error": "",
        "cancel": threading.Event(),
    }


def register(app) -> None:
    @app.route("GET", "/api/status")
    def status(req):
        state = hf_cache.install_state()
        return app.json(
            {
                "model": {
                    "id": "faster-whisper-base",
                    "repo_id": hf_cache.REPO_ID,
                    "size_hint": "~150 MB",
                    "files": list(hf_cache.REQUIRED_FILES),
                },
                "mirror": hf_cache.mirror_base_url(),
                "install": state,
            }
        )

    @app.route("POST", "/api/install")
    def install(req):
        with _jobs_lock:
            if _jobs["current"] is not None and _jobs["current"]["state"] == "running":
                return app.json(
                    {
                        "error": "an install is already running",
                        "job_id": _jobs["current"]["job_id"],
                    },
                    status=409,
                )
            job = _new_job()
            _jobs["current"] = job

        def run(job=job):
            try:
                job["result"] = hf_cache.download_model(progress=job["progress"], cancel=job["cancel"])
                # a cancel that lands after completion still means the files are there
                job["state"] = "done" if job["result"] is not None else "canceled"
            except hf_cache.InstallError as exc:
                job["error"] = str(exc)
                job["state"] = "canceled" if str(exc) == "canceled" else "error"
            except Exception:  # never leak a traceback to the caller
                job["error"] = "unexpected download failure"
                job["state"] = "error"
            finally:
                job["finished_at"] = time.time()

        threading.Thread(target=run, name="whisper-model-install", daemon=True).start()
        return app.json({"job_id": job["job_id"], "state": job["state"]})

    @app.route("GET", "/api/install")
    def install_status(req):
        with _jobs_lock:
            job = _jobs["current"]
            if job is None:
                return app.json({"state": "idle"})
            return app.json(
                {
                    "job_id": job["job_id"],
                    "state": job["state"],
                    "progress": job["progress"],
                    "result": job["result"],
                    "error": job["error"],
                    "elapsed_seconds": round(time.time() - job["started_at"], 1),
                }
            )

    @app.route("POST", "/api/install/cancel")
    def install_cancel(req):
        with _jobs_lock:
            job = _jobs["current"]
        if job is None or job["state"] != "running":
            return app.json({"state": "idle" if job is None else job["state"]})
        job["cancel"].set()
        return app.json({"job_id": job["job_id"], "state": "canceling"})

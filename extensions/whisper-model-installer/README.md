# Whisper Model Installer

Whisper Model Installer is a Hermes WebUI extension that installs the
**faster-whisper-base** speech-to-text model (`Systran/faster-whisper-base`)
with one click. It downloads the model files from the
**[hf-mirror.com](https://hf-mirror.com)** mirror (via a local loopback sidecar)
into your machine's **default Hugging Face cache directory**, using the standard
`models--Systran--faster-whisper-base` cache layout - so `faster-whisper`,
`huggingface_hub`, and anything else that reads the HF cache finds the model
offline, exactly as if `huggingface-cli download Systran/faster-whisper-base`
had run.

## What It Does

- **One-click install** - a floating mic button opens a small panel; press
  *Install faster-whisper-base* and the sidecar downloads
  `config.json`, `model.bin`, `tokenizer.json`, and `vocabulary.txt`
  (~150 MB total) from `https://hf-mirror.com/Systran/faster-whisper-base`.
- **Live progress** - byte counter, per-file indicator, and a progress bar,
  with a **Cancel** button. A ~150 MB download far outlives the WebUI proxy's
  ~10 s request timeout, so the install uses the mandated start-job + poll
  pattern - and survives a page reload (reopening the panel re-attaches to the
  running job).
- **Already-installed detection** - if `refs/main` plus all required files are
  present in the cache, the panel reports *Already installed* and downloads
  nothing.
- **Standard cache layout** - `blobs/<etag>` + `snapshots/<commit-sha>/<file>`
  + `refs/main`, atomic per file (tmp + rename), symlinks on POSIX and copies
  on Windows, matching `huggingface_hub`'s behavior.

## Current Shape

```text
Hermes WebUI page
  -> assets/whisper-installer.js   launcher button + modal panel + polling
  -> assets/whisper-installer.css  panel styles (theme-aware)
WebUI sidecar proxy (after consent)
  -> /api/extensions/whisper-model-installer/sidecar/api/status
  -> /api/extensions/whisper-model-installer/sidecar/api/install         (POST)
  -> /api/extensions/whisper-model-installer/sidecar/api/install         (GET, poll)
  -> /api/extensions/whisper-model-installer/sidecar/api/install/cancel  (POST)
  -> loopback sidecar on 127.0.0.1:17799 (sidecar/sidecar.py)
     -> https://hf-mirror.com/Systran/faster-whisper-base (download only)
     -> Hugging Face cache: HF_HUB_CACHE, else $HF_HOME/hub,
        else ~/.cache/huggingface/hub
```

The download engine (`sidecar/hf_cache.py`) is pure Python stdlib - the sidecar
runs under `python3 -S` with no `huggingface_hub` dependency.

## Supported WebUI version / API surface

Requires a Hermes WebUI build with the `token-v1` sidecar-proxy contract (first
shipped in `exp-v0.52.129`). Required surface:

- manifest-bundled asset injection (`manifest.json` scripts/stylesheets)
- `token-v1` sidecar proxy at `/api/extensions/<id>/sidecar/*` (approve the
  sidecar in **Settings -> Extensions**)
- `GET /api/extensions/status` (consent check, fail-closed)

## Sidecar (token-v1 scaffold)

Built on the canonical Hermes sidecar scaffold. `sidecar/sidecar.py` and
`sidecar/sidecar_base.py` are vendored **byte-identical** from
`examples/sidecar-scaffold/` (CI: `scripts/sync-sidecar-base.mjs --check`);
this extension's own code is `sidecar/routes_impl.py` (routes) +
`sidecar/hf_cache.py` (download engine). `sidecar/sidecar.json` declares
`{id, port, proxy_auth}`.

**Proxy auth - `token-v1`.** The loopback port is reachable by any local
process and the WebUI proxy strips inbound credentials, so the sidecar can't
tell a proxied request from a direct one. Core mints a per-extension secret and
injects `X-Hermes-Sidecar-Token`; the scaffold validates it **deny-by-default**
at one dispatch chokepoint (every route but `/health`). Missing token file ->
`503`, wrong token -> `401`. **Honest scope:** this protects against callers
that can't read the user's state dir - the same level as WebUI's own auth. It
does **not** defend against arbitrary same-UID code. Auth is fail-closed while
WebUI auth is off - enable it in **Settings -> Password**, then approve the
sidecar in **Settings -> Extensions**.

| Setting | Source | Default |
|---|---|---|
| Port | `sidecar/sidecar.json` | `17799` |
| Mirror | `HF_ENDPOINT` | `https://hf-mirror.com` |
| Cache dir | `HF_HUB_CACHE` / `HF_HOME` | `~/.cache/huggingface/hub` |

Install the systemd user unit - it runs `/usr/bin/python3 -S -u sidecar.py`
with no token in the unit (core provisions it in the state dir):

```bash
cp sidecar/whisper-model-installer-sidecar.service ~/.config/systemd/user/
systemctl --user enable --now whisper-model-installer-sidecar
```

**Health:** `GET http://127.0.0.1:17799/health` returns
`{"ok": true, "sidecar_base_version": N}`.

**Docker limitation:** a bridge-networked WebUI container cannot reach a
host-run sidecar's `127.0.0.1:17799` (loopback is namespace-local). Sidecars
work only where core and the sidecar share a network namespace and the state
dir.

## Install, disable, uninstall

- **Install**: copy the extension into the WebUI's gallery extension dir
  (`$HERMES_WEBUI_STATE_DIR/extensions/`, default `~/.hermes/webui/extensions/`),
  enable it in **Settings -> Extensions**, start the sidecar, reload. The
  extension requests sidecar-proxy consent on first load; consent can be
  granted or revoked anytime in **Settings -> Extensions**.
- **Disable**: toggle off in **Settings -> Extensions** - assets stop being
  injected on the next render (the launcher button and panel disappear). The
  installed model stays in the HF cache.
- **Uninstall**: remove it in **Settings -> Extensions** (or delete the
  directory). To also remove the downloaded model, delete
  `~/.cache/huggingface/hub/models--Systran--faster-whisper-base`.

## Trust and permissions

- Creates extension-owned DOM only (a launcher button and a modal panel); never
  mutates core views.
- Talks to its loopback sidecar only through the WebUI's consented proxy path.
- The sidecar makes **outbound HTTPS requests to exactly one host** -
  `hf-mirror.com` (or the `HF_ENDPOINT` you set) - and only for the four
  model files plus the repo metadata API. No other network access, no telemetry.
- Writes only inside the Hugging Face cache directory, in the standard layout,
  with atomic renames. File names from the mirror's API are validated against a
  strict no-traversal grammar before any path is touched.
- Reads `GET /api/extensions/status` (same-origin) for the consent check.
- No localStorage, no cookies, no native host.

## Manual verification

1. Start the sidecar, approve it in **Settings -> Extensions**, reload.
2. Click the floating mic button -> the panel shows *Not installed* plus the
   resolved cache dir.
3. Press **Install** -> the bar advances per file, ending at
   *Installed ✓* with the snapshot path.
4. Verify offline discovery:
   `python -c "from faster_whisper import WhisperModel; WhisperModel('base')"`
   resolves locally with no network, or check
   `~/.cache/huggingface/hub/models--Systran--faster-whisper-base/snapshots/`.
5. Reopen the panel -> *Already installed ✓*; **Install** does not re-download.
6. Press **Cancel** mid-download -> the job stops, partial blobs are removed,
   and **Install** can be pressed again.

## Automated verification

- `python3 scripts/test-whisper-model-installer.py` covers cache-dir resolution
  precedence, filename sanitization, install-state detection against a fake
  cache tree, and the job lifecycle (start / poll / cancel / re-run) with the
  HTTP layer monkeypatched to fixtures - no network needed.
- Repository CI also runs extension metadata, JavaScript syntax, sidecar
  contract, scaffold-sync, and safety checks on every change.

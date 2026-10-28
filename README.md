# CallShield

Real-time fraud and digital-arrest call warnings for Google Meet on desktop Chrome.
HackSplot 2026, PS1. Proof of concept.

```text
Meet tab ──► MV3 extension (offscreen capture) ──WS──► FastAPI backend ──► AI pipeline (Shlok)
  ▲  overlay / leave call                                │ evidence ledger → fusion → policy
  └──────────── assessments + action requests ◄──────────┤
                                                         ├──► dashboard (/dashboard)
                                                         └──► mock bank + incident report
```

| Folder | What |
|---|---|
| `extension/` | Manifest V3 extension: tab audio/video capture, optional mic, Meet chat ingest, overlay, leave call |
| `backend/` | FastAPI: ingest, sessions, AI adapter, fusion + policy, SQLite, mock bank, reports |
| `frontend/` | Dashboard (static, served by the backend at `/dashboard/`) |
| `integration_tests/` | `simulate_call.py`: plays the extension's role without Chrome |
| `docs/` | Contract, limitations, deliverable status |

## Run the backend

Needs a standard CPython 3.11+ (not the MSYS2/MinGW Python: it has no pydantic-core wheels).

```powershell
cd backend
py -3.11 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m pytest -q
.venv\Scripts\python -m uvicorn callshield.main:create_app --factory --port 8000
```

Open http://localhost:8000/dashboard/ (default token `dev-token`).

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `CALLSHIELD_TOKEN` | `dev-token` | Shared token for extension, dashboard and API |
| `CALLSHIELD_PIPELINE` | `mock` | `module:Class` of the AI pipeline (see `backend/callshield/adapter.py`) |
| `CALLSHIELD_RISK_CONFIG` | `backend/risk_config.yaml` | Weights / thresholds (Shlok owns the values) |
| `CALLSHIELD_DB` | `callshield.db` | SQLite file |
| `CALLSHIELD_ATTEST_SECRET` | random per run | HMAC key for simulated bank risk attestations |

## Try it without Chrome

```powershell
backend\.venv\Scripts\python integration_tests\simulate_call.py --script digital_arrest
backend\.venv\Scripts\python integration_tests\simulate_call.py --script benign
```

## Load the extension

1. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.
2. Join a Google Meet call in a tab (reload Meet tabs opened before installing).
3. Optional: in the popup click **grant access** for the microphone (one time, needs a visible page).
4. On the Meet tab, open the popup → **Start monitoring this Meet tab**.
5. Watch the overlay on Meet and the dashboard.

Auto-disconnect is **off by default**. It needs the popup checkbox *and* the backend policy gate
(critical, sustained, ≥3 corroborating behaviours incl. a strongest-class one, healthy monitoring,
non-mock inference), then an 8 s visible cancel window.

## Status

See [docs/STATUS.md](docs/STATUS.md). Nothing below "verified" has been tested on a real Meet call yet.

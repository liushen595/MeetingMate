# MeetingMate Backend

FastAPI implementation for the MVP API contract in `docs/foundation.md`.

The current implementation is an in-memory P0 backend intended to unblock frontend and API contract work. It exposes OpenAPI 3.1 from FastAPI/Pydantic and implements the Sprint 1 P0 gate endpoints for auth, assets, manuscripts, document sync, manuscript conversion tasks, and exports.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
uvicorn app.main:app --reload
```

The API base URL is `/api/v1`.

## OpenAPI

```bash
python scripts/export_openapi.py
```

This writes `openapi.json` in the `backend/` directory.

## Tests

```bash
pytest
```

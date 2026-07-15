# MeetingMate Backend

FastAPI implementation for the MVP API contract in `docs/foundation.md`.

The current implementation exposes OpenAPI 3.1 from FastAPI/Pydantic and stores backend data in PostgreSQL. It implements the Sprint 1 P0 gate endpoints for auth, assets, manuscripts, document sync, manuscript conversion tasks, and exports.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

Create `backend/.env` before starting the server:

```env
CORS_ORIGINS=[]
CORS_ORIGIN_REGEX="^https?://(localhost|127\\.0\\.0\\.1|10\\.(?:\\d{1,3}\\.){2}\\d{1,3})(?::\\d+)?$"
ALLOWED_HOSTS=[]
OBJECT_STORAGE_PUBLIC_BASE_URL="http://10.90.129.20:9000"
OBJECT_STORAGE_BUCKET="bucket"
ASSET_UPLOAD_URL_MODE="api"
API_PUBLIC_BASE_URL=""

DATABASE_HOST=127.0.0.1
DATABASE_PORT=5432
DATABASE_NAME=MeetingMate
DATABASE_USER=mm
DATABASE_PASSWORD=""
DATABASE_SSL=false
DATABASE_MIN_POOL_SIZE=1
DATABASE_MAX_POOL_SIZE=10
DATABASE_CONNECT_TIMEOUT_SECONDS=5
DATABASE_COMMAND_TIMEOUT_SECONDS=30
```

`DATABASE_URL` is also supported. If it is set, it takes precedence over the component fields above.

`ASSET_UPLOAD_URL_MODE="api"` makes `/assets/upload` return FastAPI upload proxy URLs. This is the recommended local/LAN development mode when MinIO/S3 is not reachable directly from the browser. Set `API_PUBLIC_BASE_URL` only when the backend is behind a proxy and `request.base_url` is not the browser-reachable API base URL.

```bash
uvicorn app.main:app --reload
```

The API base URL is `/api/v1`.

On startup the backend opens an async PostgreSQL pool, verifies the connection, and applies `app/schema.sql`. If `pgvector` is installed on the PostgreSQL server, the backend also creates the `block_embeddings` table; otherwise the API still starts and `/healthz` reports `pgvector: disabled`.

## OpenAPI

```bash
python scripts/export_openapi.py
```

This writes `openapi.json` in the `backend/` directory.

## Tests

```bash
pytest
```

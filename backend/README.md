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
ASSET_UPLOAD_URL_MODE="api"
API_PUBLIC_BASE_URL=""

ASR_PROVIDER="dashscope"
VISION_PROVIDER="dashscope"
DASHSCOPE_API_URL="https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1"
DASHSCOPE_API_KEY=""
DASHSCOPE_ASR_MODEL="qwen3-asr-flash"
DASHSCOPE_IMAGE_MODEL="qwen-vl-plus"

# Optional fallback provider kept for future use.
AZURE_SPEECH_ENDPOINT=""
AZURE_SPEECH_KEY=""
AZURE_SPEECH_API_VERSION="2025-10-15"

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

`ASSET_UPLOAD_URL_MODE="api"` is the only supported MVP upload mode. `/assets/upload` returns FastAPI upload proxy URLs under `/api/v1/assets/{asset_id}/upload-parts/{part_number}` and `/assets/{asset_id}/stream` serves bytes from the API. Set `API_PUBLIC_BASE_URL` only when the backend is behind a proxy and `request.base_url` is not the browser-reachable API base URL.

`ASR_PROVIDER="dashscope"` uses Alibaba Cloud Model Studio DashScope ASR. The backend sends uploaded audio as a Base64 data URI and rejects input whose Base64 payload exceeds 10MB. `AZURE_SPEECH_*` is retained as a fallback provider configuration for future Azure Speech support.

`VISION_PROVIDER="dashscope"` uses DashScope multimodal image recognition. The image model is read from `DASHSCOPE_IMAGE_MODEL` and defaults to `qwen-vl-plus` when unset.

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

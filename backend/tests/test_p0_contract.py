from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from datetime import datetime, timezone

from fastapi.testclient import TestClient

os.environ["CORS_ORIGIN_REGEX"] = r"^https?://(localhost|127\.0\.0\.1|10\.(?:\d{1,3}\.){2}\d{1,3})(?::\d+)?$"
os.environ["OBJECT_STORAGE_PUBLIC_BASE_URL"] = "http://10.90.129.20:9000"
os.environ["OBJECT_STORAGE_BUCKET"] = "bucket"
os.environ["API_PUBLIC_BASE_URL"] = "http://testserver"
os.environ["MEETINGMATE_SKIP_DOTENV"] = "1"

import app.main as backend
from app.asr import AsrProvider, AsrResult, AsrSegment


class TestAsrProvider(AsrProvider):
    async def transcribe(
        self,
        *,
        filename: str,
        content_type: str,
        content: bytes,
        duration_ms: int | None,
        language: str,
        enable_diarization: bool,
    ) -> AsrResult:
        assert content
        text = "你好，我是谁"
        segments = [AsrSegment(speaker_id="speaker_1", start_ms=0, end_ms=max(duration_ms or 0, 1), text=text, confidence=1.0)]
        return AsrResult(transcript=text, speaker_segments=segments if enable_diarization else [])

    async def stream_transcribe(
        self,
        *,
        filename: str,
        content_type: str,
        content: bytes,
        duration_ms: int | None,
        language: str,
        enable_diarization: bool,
    ):
        assert content
        yield "你好，"
        yield "你好，我是谁"


class TestRepository:
    def reset(self) -> None:
        self.users_by_id: dict[str, backend.UserRecord] = {}
        self.user_id_by_email: dict[str, str] = {}
        self.devices_by_user: dict[str, dict[str, backend.Device]] = {}
        self.access_tokens: dict[str, backend.TokenSession] = {}
        self.refresh_tokens: dict[str, backend.TokenSession] = {}
        self.idempotency: dict[tuple[str, str, str, str], backend.IdempotencyRecord] = {}
        self.assets: dict[str, backend.AssetRecord] = {}
        self.manuscripts: dict[str, backend.Manuscript] = {}
        self.documents: dict[str, backend.Document] = {}
        self.document_versions: dict[str, list[backend.DocumentVersionRecord]] = {}
        self.tasks: dict[str, tuple[str, backend.Task]] = {}
        self.exports: dict[str, backend.ExportRecord] = {}
        self.share_links: dict[str, backend.ShareLinkRecord] = {}

    async def get_user_record(self, user_id: str) -> backend.UserRecord | None:
        return self.users_by_id.get(user_id)

    async def get_user_record_by_email(self, email: str) -> backend.UserRecord | None:
        user_id = self.user_id_by_email.get(email.lower())
        return self.users_by_id.get(user_id) if user_id else None

    async def create_user(self, user: backend.User, encoded_password: str) -> None:
        self.users_by_id[user.id] = backend.UserRecord(user=user, password_hash=encoded_password)
        self.user_id_by_email[str(user.email).lower()] = user.id

    async def create_tokens(self, user_id: str, client_id: str) -> backend.AuthResponse:
        user = self.users_by_id[user_id].user
        access_token = backend.make_token("access")
        refresh_token = backend.make_token("refresh")
        now = backend.utcnow()
        self.access_tokens[access_token] = backend.TokenSession(user_id, client_id, now + backend.timedelta(seconds=backend.ACCESS_TOKEN_SECONDS))
        self.refresh_tokens[refresh_token] = backend.TokenSession(user_id, client_id, now + backend.timedelta(seconds=backend.REFRESH_TOKEN_SECONDS))
        return backend.AuthResponse(
            access_token=access_token,
            access_token_expires_in=backend.ACCESS_TOKEN_SECONDS,
            refresh_token=refresh_token,
            refresh_token_expires_in=backend.REFRESH_TOKEN_SECONDS,
            user=user,
        )

    async def get_token_session(self, token: str, token_type: str) -> backend.TokenSession | None:
        source = self.access_tokens if token_type == "access" else self.refresh_tokens
        return source.get(token)

    async def delete_token(self, token: str) -> None:
        self.access_tokens.pop(token, None)
        self.refresh_tokens.pop(token, None)

    async def delete_tokens_for_client(self, user_id: str, client_id: str) -> None:
        for token, session in list(self.access_tokens.items()):
            if session.user_id == user_id and session.client_id == client_id:
                del self.access_tokens[token]
        for token, session in list(self.refresh_tokens.items()):
            if session.user_id == user_id and session.client_id == client_id:
                del self.refresh_tokens[token]

    async def upsert_device(self, user_id: str, device_input: backend.DeviceInput) -> backend.Device:
        now = backend.utcnow()
        devices = self.devices_by_user.setdefault(user_id, {})
        existing = devices.get(device_input.client_id)
        device = backend.Device(
            id=device_input.client_id,
            platform=device_input.platform,
            app_version=device_input.app_version,
            name=device_input.name,
            last_seen_at=now,
            created_at=existing.created_at if existing else now,
        )
        devices[device.id] = device
        return device

    async def touch_device(self, user_id: str, client_id: str) -> None:
        device = self.devices_by_user.get(user_id, {}).get(client_id)
        if device:
            self.devices_by_user[user_id][client_id] = device.model_copy(update={"last_seen_at": backend.utcnow()})

    async def list_devices(self, user_id: str) -> list[backend.Device]:
        devices = list(self.devices_by_user.get(user_id, {}).values())
        return sorted(devices, key=lambda item: (item.last_seen_at, item.id), reverse=True)

    async def delete_device(self, user_id: str, client_id: str) -> bool:
        devices = self.devices_by_user.get(user_id, {})
        if client_id not in devices:
            return False
        del devices[client_id]
        await self.delete_tokens_for_client(user_id, client_id)
        return True

    async def get_idempotency(self, scope: tuple[str, str, str, str]) -> backend.IdempotencyRecord | None:
        return self.idempotency.get(scope)

    async def save_idempotency(self, scope: tuple[str, str, str, str], record: backend.IdempotencyRecord) -> None:
        self.idempotency[scope] = record

    async def save_asset(self, record: backend.AssetRecord) -> None:
        self.assets[record.asset.id] = record

    async def get_asset_record(self, asset_id: str) -> backend.AssetRecord | None:
        return self.assets.get(asset_id)

    async def delete_asset(self, asset_id: str) -> None:
        del self.assets[asset_id]

    async def asset_is_referenced(self, owner_id: str, asset_id: str) -> bool:
        for manuscript in self.manuscripts.values():
            if manuscript.owner_id != owner_id:
                continue
            for block in manuscript.blocks:
                if isinstance(block, (backend.ManuscriptAudioBlock, backend.ManuscriptImageBlock)) and block.props.asset_id == asset_id:
                    return True
                if isinstance(block, backend.ManuscriptHandwritingBlock) and block.props.image_asset_id == asset_id:
                    return True
        for document in self.documents.values():
            if document.owner_id != owner_id:
                continue
            for block in document.blocks:
                if isinstance(block, backend.DocumentImageBlock) and block.props.asset_id == asset_id:
                    return True
        return False

    async def list_manuscripts(self, owner_id: str, include_deleted: bool = False) -> list[backend.Manuscript]:
        items = [item for item in self.manuscripts.values() if item.owner_id == owner_id and (include_deleted or not item.deleted)]
        return sorted(items, key=lambda item: (item.updated_at, item.id), reverse=True)

    async def get_manuscript(self, manuscript_id: str) -> backend.Manuscript | None:
        return self.manuscripts.get(manuscript_id)

    async def save_manuscript(self, manuscript: backend.Manuscript) -> None:
        self.manuscripts[manuscript.id] = manuscript

    async def list_documents(self, owner_id: str) -> list[backend.Document]:
        items = [item for item in self.documents.values() if item.owner_id == owner_id]
        return sorted(items, key=lambda item: (item.updated_at, item.id), reverse=True)

    async def get_document(self, document_id: str) -> backend.Document | None:
        return self.documents.get(document_id)

    async def save_document(self, document: backend.Document) -> None:
        self.documents[document.id] = document

    async def delete_document(self, document_id: str) -> None:
        del self.documents[document_id]

    async def create_document_version(self, document: backend.Document, title: str) -> None:
        version = backend.DocumentVersion(
            id=backend.new_id("ver"),
            document_id=document.id,
            revision=document.revision,
            title=title,
            created_by=document.owner_id,
            created_at=backend.utcnow(),
        )
        self.document_versions.setdefault(document.id, []).append(backend.DocumentVersionRecord(version=version, snapshot=document.model_copy(deep=True)))

    async def list_document_versions(self, document_id: str) -> list[backend.DocumentVersion]:
        versions = [record.version for record in self.document_versions.get(document_id, [])]
        return sorted(versions, key=lambda item: (item.created_at, item.id), reverse=True)

    async def find_document_version(self, document_id: str, version_id: str) -> backend.DocumentVersionRecord | None:
        for record in self.document_versions.get(document_id, []):
            if record.version.id == version_id:
                return record
        return None

    async def save_task(self, owner_id: str, task: backend.Task, task_input: dict | None = None) -> None:
        self.tasks[task.id] = (owner_id, task)

    async def get_task_record(self, task_id: str) -> tuple[str, backend.Task] | None:
        return self.tasks.get(task_id)

    async def save_export(self, record: backend.ExportRecord) -> None:
        self.exports[record.export_id] = record

    async def get_export_record(self, export_id: str) -> backend.ExportRecord | None:
        return self.exports.get(export_id)

    async def save_share_link(self, record: backend.ShareLinkRecord) -> None:
        self.share_links[record.link.id] = record

    async def get_share_link_record(self, share_id: str) -> backend.ShareLinkRecord | None:
        return self.share_links.get(share_id)


repo = TestRepository()
repo.reset()
app = backend.app
app.dependency_overrides[backend.get_repository] = lambda: repo
app.state.asr_provider = TestAsrProvider()


client = TestClient(app)


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def register_user(email: str = "alice@example.com", device_id: str = "device_test"):
    response = client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "secret",
            "name": "Alice",
            "device": {"client_id": device_id, "platform": "web", "app_version": "1.0.0", "name": "Browser"},
        },
        headers={"X-Request-Id": "req_test"},
    )
    assert response.status_code == 201, response.text
    assert response.headers["X-Request-Id"] == "req_test"
    return response.json()


def auth_headers(auth: dict, device_id: str = "device_test", idempotency_key: str | None = None) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {auth['access_token']}", "X-Client-Id": device_id}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    return headers


def upload_single_part(upload_response, content: bytes) -> dict:
    part = upload_response.json()["parts"][0]
    response = client.put(part["upload_url"], content=content, headers=part["headers"])
    assert response.status_code == 200, response.text
    metadata = response.json()
    assert metadata == {"part_number": part["part_number"], "etag": response.headers["etag"], "size_bytes": len(content)}
    return metadata


def sse_events(text: str, event_name: str) -> list[dict]:
    payloads: list[dict] = []
    for chunk in text.strip().split("\n\n"):
        lines = chunk.splitlines()
        if f"event: {event_name}" not in lines:
            continue
        for line in lines:
            if line.startswith("data: "):
                payloads.append(json.loads(line.removeprefix("data: ")))
    return payloads


def test_cors_preflight_allows_localhost_and_10_private_network() -> None:
    for origin in ["http://localhost:5173", "http://127.0.0.1:5173", "http://10.90.129.105:5173"]:
        response = client.options(
            "/api/v1/auth/register",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type,x-client-id,x-request-id,idempotency-key,last-event-id",
            },
        )
        assert response.status_code == 200, response.text
        assert response.headers["access-control-allow-origin"] == origin
        assert "authorization" in response.headers["access-control-allow-headers"].lower()
        assert "last-event-id" in response.headers["access-control-allow-headers"].lower()


def test_postgres_asset_save_persists_part_contents_as_base64_jsonb() -> None:
    class FakePool:
        def __init__(self) -> None:
            self.calls = []

        async def execute(self, query: str, *args):
            self.calls.append((query, args))

    now = backend.utcnow()
    fake_pool = FakePool()
    postgres = backend.PostgresRepository.__new__(backend.PostgresRepository)
    postgres.pool = fake_pool
    content = b"0123456789"
    record = backend.AssetRecord(
        owner_id="u_test",
        asset=backend.Asset(
            id="asset_test",
            kind="audio",
            filename="meeting.m4a",
            content_type="audio/mp4",
            size_bytes=len(content),
            checksum_sha256=hashlib.sha256(content).hexdigest(),
            duration_ms=None,
            width=None,
            height=None,
            status="uploaded",
            url=None,
            created_at=now,
            updated_at=now,
        ),
        upload_id="upload_test",
        part_size_bytes=len(content),
        uploaded_parts=[backend.UploadedPart(part_number=1, etag=hashlib.sha256(content).hexdigest(), size_bytes=len(content))],
        part_contents={1: content},
    )

    asyncio.run(postgres.save_asset(record))

    query, args = fake_pool.calls[0]
    assert "part_contents" in query
    assert json.loads(args[15]) == {"1": base64.b64encode(content).decode("ascii")}


def test_p0_flow_register_upload_manuscript_convert_export() -> None:
    repo.reset()
    auth = register_user()
    upload_content = b"0123456789"
    upload_checksum = hashlib.sha256(upload_content).hexdigest()
    upload = client.post(
        "/api/v1/assets/upload",
        json={
            "kind": "audio",
            "filename": "meeting.m4a",
            "content_type": "audio/mp4",
            "size_bytes": 10,
            "checksum_sha256": upload_checksum,
            "part_size_bytes": 10,
        },
        headers=auth_headers(auth, idempotency_key="idem_upload"),
    )
    assert upload.status_code == 201, upload.text
    assert upload.json()["parts"][0]["upload_url"].startswith("http://testserver/api/v1/assets/")
    assert "object-storage.local" not in upload.json()["parts"][0]["upload_url"]
    uploaded_part = upload_single_part(upload, upload_content)
    asset_id = upload.json()["asset_id"]
    upload_parts = client.get(f"/api/v1/assets/{asset_id}/upload-parts", headers=auth_headers(auth))
    assert upload_parts.status_code == 200, upload_parts.text
    assert upload_parts.json()["uploaded_parts"] == [uploaded_part]
    assert upload_parts.json()["missing_parts"] == []
    complete = client.post(
        f"/api/v1/assets/{asset_id}/complete",
        json={
            "upload_id": upload.json()["upload_id"],
            "size_bytes": 10,
            "checksum_sha256": upload_checksum,
            "parts": [uploaded_part],
            "duration_ms": 1000,
            "width": None,
            "height": None,
        },
        headers=auth_headers(auth, idempotency_key="idem_complete"),
    )
    assert complete.status_code == 200, complete.text
    assert complete.json()["status"] == "ready"
    stream_headers = auth_headers(auth)
    stream_headers["Origin"] = "http://10.90.129.105:5173"
    stream = client.get(f"/api/v1/assets/{asset_id}/stream", headers=stream_headers)
    assert stream.status_code == 200, stream.text
    assert stream.content == upload_content
    assert stream.headers["content-type"] == "audio/mp4"
    assert stream.headers["content-length"] == str(len(upload_content))
    assert stream.headers["accept-ranges"] == "bytes"
    assert "inline" in stream.headers["content-disposition"]
    assert "etag" in stream.headers["access-control-expose-headers"].lower()
    assert "content-disposition" in stream.headers["access-control-expose-headers"].lower()

    created_at = iso_now()
    manuscript = client.post(
        "/api/v1/manuscripts",
        json={"title": "Meeting", "client_id": "device_test", "initial_blocks": []},
        headers=auth_headers(auth, idempotency_key="idem_manuscript"),
    )
    assert manuscript.status_code == 201, manuscript.text
    manuscript_id = manuscript.json()["id"]
    sync = client.put(
        f"/api/v1/manuscripts/{manuscript_id}/blocks",
        json={
            "client_id": "device_test",
            "base_revision": 1,
            "operations": [
                {
                    "op_id": "op_1",
                    "type": "upsert_block",
                    "block": {
                        "id": "block_text1",
                        "type": "text",
                        "revision": 1,
                        "created_at": created_at,
                        "updated_at": created_at,
                        "author_id": auth["user"]["id"],
                        "client_id": "device_test",
                        "platform": "web",
                        "deleted": False,
                        "props": {"content": "Ship the mobile editor first."},
                    },
                    "block_id": None,
                    "before_block_id": None,
                    "after_block_id": None,
                    "created_at": created_at,
                }
            ],
        },
        headers=auth_headers(auth, idempotency_key="idem_sync_manuscript"),
    )
    assert sync.status_code == 200, sync.text
    assert sync.json()["revision"] == 2

    convert = client.post(
        "/api/v1/tasks/convert-manuscript",
        json={"manuscript_id": manuscript_id, "mode": "meeting_minutes", "title": "Minutes", "client_id": "device_test"},
        headers=auth_headers(auth, idempotency_key="idem_convert"),
    )
    assert convert.status_code == 202, convert.text
    assert convert.json()["status"] == "succeeded"
    document_id = convert.json()["result"]["document_id"]
    document = client.get(f"/api/v1/documents/{document_id}", headers=auth_headers(auth))
    assert document.status_code == 200, document.text
    assert document.json()["derived_from"]["manuscript_id"] == manuscript_id
    assert document.json()["blocks"][0]["source_refs"][0]["block_id"] == "block_text1"

    export = client.post(
        "/api/v1/exports",
        json={"document_id": document_id, "format": "pdf", "client_id": "device_test"},
        headers=auth_headers(auth, idempotency_key="idem_export"),
    )
    assert export.status_code == 202, export.text
    export_id = export.json()["result"]["export_id"]
    download = client.get(f"/api/v1/exports/{export_id}/download", headers=auth_headers(auth))
    assert download.status_code == 200, download.text
    assert download.json()["download_url"].startswith("http://testserver/api/v1/assets/")


def test_asset_stream_can_fallback_to_stored_part_contents() -> None:
    repo.reset()
    auth = register_user("parts-stream@example.com", "device_parts_stream")
    content = b"part-content"
    checksum = hashlib.sha256(content).hexdigest()
    now = backend.utcnow()
    asset = backend.Asset(
        id="asset_parts_stream",
        kind="audio",
        filename="recording.webm",
        content_type="audio/webm",
        size_bytes=len(content),
        checksum_sha256=checksum,
        duration_ms=1000,
        width=None,
        height=None,
        status="ready",
        url=None,
        created_at=now,
        updated_at=now,
    )
    repo.assets[asset.id] = backend.AssetRecord(
        owner_id=auth["user"]["id"],
        asset=asset,
        upload_id="upload_parts_stream",
        part_size_bytes=len(content),
        uploaded_parts=[backend.UploadedPart(part_number=1, etag=checksum, size_bytes=len(content))],
        content=None,
        part_contents={1: content},
    )

    stream = client.get(f"/api/v1/assets/{asset.id}/stream", headers=auth_headers(auth, "device_parts_stream"))
    assert stream.status_code == 200, stream.text
    assert stream.content == content
    assert stream.headers["content-type"] == "audio/webm"


def test_idempotency_conflict_and_revision_conflict() -> None:
    repo.reset()
    auth = register_user("bob@example.com", "device_bob")
    headers = auth_headers(auth, "device_bob", "same_key")
    first = client.post("/api/v1/manuscripts", json={"title": "A", "client_id": "device_bob", "initial_blocks": []}, headers=headers)
    assert first.status_code == 201, first.text
    replay = client.post("/api/v1/manuscripts", json={"title": "A", "client_id": "device_bob", "initial_blocks": []}, headers=headers)
    assert replay.status_code == 201, replay.text
    conflict = client.post("/api/v1/manuscripts", json={"title": "B", "client_id": "device_bob", "initial_blocks": []}, headers=headers)
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "idempotency_conflict"

    manuscript_id = first.json()["id"]
    stale = client.put(
        f"/api/v1/manuscripts/{manuscript_id}/blocks",
        json={"client_id": "device_bob", "base_revision": 0, "operations": []},
        headers=auth_headers(auth, "device_bob", "stale_key"),
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "revision_conflict"


def test_openapi_declares_required_auth_and_write_headers() -> None:
    schema = client.get("/openapi.json").json()
    assert "HTTPBearer" in schema["components"]["securitySchemes"]
    upload = schema["paths"]["/api/v1/assets/upload"]["post"]
    parameter_names = {parameter["name"] for parameter in upload["parameters"]}
    assert {"X-Client-Id", "Idempotency-Key"}.issubset(parameter_names)
    assert upload["security"] == [{"HTTPBearer": []}]


def test_logout_revokes_current_access_token() -> None:
    repo.reset()
    auth = register_user("logout@example.com", "device_logout")
    logout = client.post(
        "/api/v1/auth/logout",
        json={"client_id": "device_logout", "refresh_token": auth["refresh_token"]},
        headers=auth_headers(auth, "device_logout"),
    )
    assert logout.status_code == 204, logout.text
    devices = client.get("/api/v1/devices", headers=auth_headers(auth, "device_logout"))
    assert devices.status_code == 401


def test_manual_document_rejects_forged_derived_from() -> None:
    repo.reset()
    auth = register_user("doc@example.com", "device_doc")
    response = client.post(
        "/api/v1/documents",
        json={
            "title": "Forged",
            "client_id": "device_doc",
            "source_manuscript_ids": [],
            "derived_from": {
                "manuscript_id": "m_fake",
                "task_id": "task_fake",
                "mode": "meeting_minutes",
                "converted_at": iso_now(),
            },
            "initial_blocks": [],
        },
        headers=auth_headers(auth, "device_doc", "idem_doc_forged"),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_asr_task_succeeds_and_updates_audio_block() -> None:
    repo.reset()
    auth = register_user("asr@example.com", "device_asr")
    upload_content = b"0123456789"
    upload_checksum = hashlib.sha256(upload_content).hexdigest()
    upload = client.post(
        "/api/v1/assets/upload",
        json={
            "kind": "audio",
            "filename": "meeting.m4a",
            "content_type": "audio/mp4",
            "size_bytes": 10,
            "checksum_sha256": upload_checksum,
            "part_size_bytes": 10,
        },
        headers=auth_headers(auth, "device_asr", "idem_asr_upload"),
    )
    asset_id = upload.json()["asset_id"]
    uploaded_part = upload_single_part(upload, upload_content)
    complete = client.post(
        f"/api/v1/assets/{asset_id}/complete",
        json={
            "upload_id": upload.json()["upload_id"],
            "size_bytes": 10,
            "checksum_sha256": upload_checksum,
            "parts": [uploaded_part],
            "duration_ms": 1000,
            "width": None,
            "height": None,
        },
        headers=auth_headers(auth, "device_asr", "idem_asr_complete"),
    )
    assert complete.status_code == 200, complete.text

    created_at = iso_now()
    manuscript = client.post(
        "/api/v1/manuscripts",
        json={
            "title": "Audio",
            "client_id": "device_asr",
            "initial_blocks": [
                {
                    "id": "block_audio1",
                    "type": "audio",
                    "revision": 1,
                    "created_at": created_at,
                    "updated_at": created_at,
                    "author_id": auth["user"]["id"],
                    "client_id": "device_asr",
                    "platform": "web",
                    "deleted": False,
                    "props": {"asset_id": asset_id, "duration_ms": 1000, "transcript": "existing transcript", "speaker_segments": []},
                }
            ],
        },
        headers=auth_headers(auth, "device_asr", "idem_asr_manuscript"),
    )
    assert manuscript.status_code == 201, manuscript.text
    asr = client.post(
        "/api/v1/tasks/asr-audio",
        json={"asset_id": asset_id, "language": "zh-CN", "enable_diarization": True, "client_id": "device_asr"},
        headers=auth_headers(auth, "device_asr", "idem_asr_task"),
    )
    assert asr.status_code == 202, asr.text
    assert asr.json()["status"] == "queued"
    task_id = asr.json()["id"]
    task = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers(auth, "device_asr"))
    assert task.status_code == 200, task.text
    assert task.json()["status"] == "succeeded"
    assert task.json()["result"]["asset_id"] == asset_id
    assert task.json()["result"]["transcript"] == "你好，我是谁"
    fetched = client.get(f"/api/v1/manuscripts/{manuscript.json()['id']}", headers=auth_headers(auth, "device_asr"))
    audio_props = fetched.json()["blocks"][0]["props"]
    assert audio_props["transcript"] == "你好，我是谁"
    assert audio_props["speaker_segments"][0]["speaker_id"] == "speaker_1"
    assert audio_props["asr_task_id"] == task_id
    assert audio_props["asr_generated_at"] is not None

    cancel_headers = auth_headers(auth, "device_asr", "idem_cancel_asr")
    cancel = client.post(f"/api/v1/tasks/{task_id}/cancel", headers=cancel_headers)
    assert cancel.status_code == 409, cancel.text

    streamed = client.post(
        "/api/v1/tasks/asr-audio/stream",
        json={"asset_id": asset_id, "language": "zh-CN", "enable_diarization": True, "client_id": "device_asr"},
        headers=auth_headers(auth, "device_asr", "idem_stream_asr_task"),
    )
    assert streamed.status_code == 200, streamed.text
    assert "event: delta" in streamed.text
    assert "你好，我是谁" in streamed.text
    assert "event: done" in streamed.text
    done_task = sse_events(streamed.text, "done")[0]["task"]
    assert done_task["result"]["asset_id"] == asset_id
    assert done_task["result"]["transcript"] == "你好，我是谁"
    fetched_after_stream = client.get(f"/api/v1/manuscripts/{manuscript.json()['id']}", headers=auth_headers(auth, "device_asr"))
    audio_props_after_stream = fetched_after_stream.json()["blocks"][0]["props"]
    assert audio_props_after_stream["transcript"] == "你好，我是谁"
    assert audio_props_after_stream["asr_task_id"] == done_task["id"]
    assert audio_props_after_stream["asr_generated_at"] is not None


def test_document_version_restore_restores_snapshot_content() -> None:
    repo.reset()
    auth = register_user("versions@example.com", "device_versions")
    created_at = iso_now()
    document = client.post(
        "/api/v1/documents",
        json={
            "title": "Draft",
            "client_id": "device_versions",
            "source_manuscript_ids": [],
            "derived_from": None,
            "initial_blocks": [
                {
                    "id": "doc_block_1",
                    "type": "paragraph",
                    "revision": 1,
                    "created_at": created_at,
                    "updated_at": created_at,
                    "author_id": auth["user"]["id"],
                    "client_id": "device_versions",
                    "platform": "web",
                    "deleted": False,
                    "props": {"content": "original"},
                    "source_refs": [],
                }
            ],
        },
        headers=auth_headers(auth, "device_versions", "idem_versions_doc"),
    )
    assert document.status_code == 201, document.text
    document_id = document.json()["id"]
    version_id = client.get(f"/api/v1/documents/{document_id}/versions", headers=auth_headers(auth, "device_versions")).json()["items"][0]["id"]

    updated_at = iso_now()
    sync = client.put(
        f"/api/v1/documents/{document_id}/blocks",
        json={
            "client_id": "device_versions",
            "base_revision": 1,
            "operations": [
                {
                    "op_id": "op_update_doc",
                    "type": "upsert_block",
                    "block": {
                        "id": "doc_block_1",
                        "type": "paragraph",
                        "revision": 2,
                        "created_at": created_at,
                        "updated_at": updated_at,
                        "author_id": auth["user"]["id"],
                        "client_id": "device_versions",
                        "platform": "web",
                        "deleted": False,
                        "props": {"content": "edited"},
                        "source_refs": [],
                    },
                    "block_id": None,
                    "before_block_id": None,
                    "after_block_id": None,
                    "created_at": updated_at,
                }
            ],
        },
        headers=auth_headers(auth, "device_versions", "idem_versions_sync"),
    )
    assert sync.status_code == 200, sync.text
    restore = client.post(
        f"/api/v1/documents/{document_id}/versions/{version_id}/restore",
        json={"client_id": "device_versions", "base_revision": sync.json()["revision"]},
        headers=auth_headers(auth, "device_versions"),
    )
    assert restore.status_code == 200, restore.text
    assert restore.json()["blocks"][0]["props"]["content"] == "original"

from __future__ import annotations

from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.main import app, store


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


def test_p0_flow_register_upload_manuscript_convert_export() -> None:
    store.__init__()
    auth = register_user()
    upload = client.post(
        "/api/v1/assets/upload",
        json={
            "kind": "audio",
            "filename": "meeting.m4a",
            "content_type": "audio/mp4",
            "size_bytes": 10,
            "checksum_sha256": "abc",
            "part_size_bytes": 10,
        },
        headers=auth_headers(auth, idempotency_key="idem_upload"),
    )
    assert upload.status_code == 201, upload.text
    asset_id = upload.json()["asset_id"]
    complete = client.post(
        f"/api/v1/assets/{asset_id}/complete",
        json={
            "upload_id": upload.json()["upload_id"],
            "size_bytes": 10,
            "checksum_sha256": "abc",
            "parts": [{"part_number": 1, "etag": "etag", "size_bytes": 10}],
            "duration_ms": 1000,
            "width": None,
            "height": None,
        },
        headers=auth_headers(auth, idempotency_key="idem_complete"),
    )
    assert complete.status_code == 200, complete.text
    assert complete.json()["status"] == "ready"

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
    assert download.json()["download_url"].startswith("https://object-storage.local/")


def test_idempotency_conflict_and_revision_conflict() -> None:
    store.__init__()
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
    store.__init__()
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
    store.__init__()
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


def test_asr_task_queues_without_overwriting_existing_transcript_and_cancel_is_idempotent() -> None:
    store.__init__()
    auth = register_user("asr@example.com", "device_asr")
    upload = client.post(
        "/api/v1/assets/upload",
        json={
            "kind": "audio",
            "filename": "meeting.m4a",
            "content_type": "audio/mp4",
            "size_bytes": 10,
            "checksum_sha256": "abc",
            "part_size_bytes": 10,
        },
        headers=auth_headers(auth, "device_asr", "idem_asr_upload"),
    )
    asset_id = upload.json()["asset_id"]
    complete = client.post(
        f"/api/v1/assets/{asset_id}/complete",
        json={
            "upload_id": upload.json()["upload_id"],
            "size_bytes": 10,
            "checksum_sha256": "abc",
            "parts": [{"part_number": 1, "etag": "etag", "size_bytes": 10}],
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
    fetched = client.get(f"/api/v1/manuscripts/{manuscript.json()['id']}", headers=auth_headers(auth, "device_asr"))
    assert fetched.json()["blocks"][0]["props"]["transcript"] == "existing transcript"

    task_id = asr.json()["id"]
    cancel_headers = auth_headers(auth, "device_asr", "idem_cancel_asr")
    cancel = client.post(f"/api/v1/tasks/{task_id}/cancel", headers=cancel_headers)
    assert cancel.status_code == 200, cancel.text
    assert cancel.json()["status"] == "cancelled"
    replay = client.post(f"/api/v1/tasks/{task_id}/cancel", headers=cancel_headers)
    assert replay.status_code == 200, replay.text
    assert replay.json()["status"] == "cancelled"


def test_document_version_restore_restores_snapshot_content() -> None:
    store.__init__()
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

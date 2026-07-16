from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from datetime import datetime, timezone

from fastapi.testclient import TestClient

os.environ["CORS_ORIGIN_REGEX"] = r"^https?://(localhost|127\.0\.0\.1|10\.(?:\d{1,3}\.){2}\d{1,3})(?::\d+)?$"
os.environ["API_PUBLIC_BASE_URL"] = "http://testserver"
os.environ["MEETINGMATE_SKIP_DOTENV"] = "1"

import app.main as backend
from app.asr import AsrProvider, AsrResult, AsrSegment
from app.text import TextProvider, TextStreamChunk
from app.vision import VisionProvider, VisionResult, build_image_prompt, result_from_text as vision_result_from_text


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


class TestVisionProvider(VisionProvider):
    calls: list[dict[str, object]] = []

    @classmethod
    def reset_calls(cls) -> None:
        cls.calls = []

    async def recognize(
        self,
        *,
        filename: str,
        content_type: str,
        content: bytes,
        width: int | None,
        height: int | None,
        language: str,
        prompt: str | None = None,
    ) -> VisionResult:
        assert filename
        assert content_type.startswith("image/")
        assert content
        self.calls.append({"filename": filename, "content_type": content_type, "content": content, "prompt": prompt})
        if prompt and "手写手稿" in prompt:
            assert content_type == "image/png"
            assert content.startswith(b"\x89PNG\r\n\x1a\n")
            return VisionResult(
                caption="手写流程图",
                text="```json\n"
                + json.dumps(
                    {
                        "recognized_text": "移动端优先推进",
                        "has_keepable_drawing": True,
                        "drawing_caption": "手写流程图",
                        "confidence": 0.86,
                    },
                    ensure_ascii=False,
                )
                + "\n```",
            )
        return VisionResult(
            caption="白板架构图",
            text="```json\n"
            + json.dumps(
                {
                    "caption": "白板架构图",
                    "text": "# 白板架构图\n- 移动端、PC 端和后端 API 协作。",
                },
                ensure_ascii=False,
            )
            + "\n```",
        )

    async def stream_recognize(
        self,
        *,
        filename: str,
        content_type: str,
        content: bytes,
        width: int | None,
        height: int | None,
        language: str,
        prompt: str | None = None,
    ):
        assert content
        text = "```json\n" + json.dumps({"caption": "白板架构图", "text": "# 白板架构图\n- 移动端、PC 端和后端 API 协作。"}, ensure_ascii=False) + "\n```"
        yield "```json\n"
        yield text


class TestTextProvider(TextProvider):
    result: dict = {
        "summary": "将选中段落整理为 3 条要点",
        "tool_calls": [
            {
                "name": "convert_to_list",
                "args": {"block_id": "doc_block_1", "style": "bullet", "items": ["第一点", "第二点", "第三点"]},
            }
        ],
    }

    @classmethod
    def set_result(cls, result: dict) -> None:
        cls.result = result

    async def clean_transcript(self, text: str, language: str = "zh-CN") -> str:
        assert language == "zh-CN"
        return text.replace("嗯", "").replace("就是", "").strip()

    async def stream_json_completion(self, *, messages: list[dict[str, str]], response_format: dict[str, str], enable_thinking: bool):
        assert response_format == {"type": "json_object"}
        assert enable_thinking is True
        assert "JSON" in messages[0]["content"] or "json" in messages[0]["content"]
        yield TextStreamChunk(reasoning_content="分析选中内容")
        yield TextStreamChunk(content=json.dumps(self.result, ensure_ascii=False))
        yield TextStreamChunk(usage={"input_tokens": 12, "output_tokens": 8})


def test_vision_result_from_json_removes_caption_and_markdown() -> None:
    raw = "```json\n" + json.dumps(
        {
            "caption": "白板架构图",
            "text": "# 白板架构图\n|事项|负责人|\n|---|---|\n|移动端适配|小李|\n- 完成接口联调\n* 跟进验收",
        },
        ensure_ascii=False,
    ) + "\n```"

    result = vision_result_from_text(raw)

    assert result.caption == "白板架构图"
    assert result.text == "事项\t负责人\n移动端适配\t小李\n完成接口联调\n跟进验收"
    assert "白板架构图" not in result.text
    assert "#" not in result.text
    assert "|---|" not in result.text


def test_default_image_prompt_requests_frontend_ready_json() -> None:
    prompt = build_image_prompt(None, "zh-CN", 320, 200)

    assert "只输出 JSON" in prompt
    assert '返回格式：\n{"caption":"","text":""}' in prompt
    assert "text 不要重复 caption" in prompt
    assert "不要使用 Markdown" in prompt
    assert "用户语言偏好：zh-CN" in prompt
    assert "图片尺寸：320x200" in prompt


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
        self.groups: dict[str, backend.GroupRecord] = {}
        self.group_members: dict[tuple[str, str], tuple[backend.GroupRole, datetime]] = {}
        self.group_messages: dict[str, backend.GroupDocumentMessageRecord] = {}

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

    async def create_group(self, group: backend.GroupRecord) -> bool:
        if any(existing.invite_code == group.invite_code for existing in self.groups.values()):
            return False
        self.groups[group.id] = group
        self.group_members[(group.id, group.created_by)] = ("owner", group.created_at)
        return True

    async def get_group_record(self, group_id: str) -> backend.GroupRecord | None:
        return self.groups.get(group_id)

    async def get_group_record_by_invite_code(self, invite_code: str) -> backend.GroupRecord | None:
        for group in self.groups.values():
            if group.invite_code == invite_code:
                return group
        return None

    async def get_group_member_role(self, group_id: str, user_id: str) -> backend.GroupRole | None:
        member = self.group_members.get((group_id, user_id))
        return member[0] if member else None

    async def add_group_member(self, group_id: str, user_id: str, role: backend.GroupRole, joined_at: datetime) -> bool:
        key = (group_id, user_id)
        if key in self.group_members:
            return False
        self.group_members[key] = (role, joined_at)
        group = self.groups[group_id]
        self.groups[group_id] = backend.GroupRecord(
            id=group.id,
            name=group.name,
            invite_code=group.invite_code,
            invite_code_expires_at=group.invite_code_expires_at,
            created_by=group.created_by,
            created_at=group.created_at,
            updated_at=joined_at,
        )
        return True

    async def list_groups_for_user(self, user_id: str) -> list[backend.GroupSummary]:
        summaries = [await self.get_group_summary_for_user(group_id, user_id) for group_id, member_user_id in self.group_members if member_user_id == user_id]
        return sorted([summary for summary in summaries if summary], key=lambda item: (item.updated_at, item.id), reverse=True)

    async def get_group_summary_for_user(self, group_id: str, user_id: str) -> backend.GroupSummary | None:
        member = self.group_members.get((group_id, user_id))
        group = self.groups.get(group_id)
        if not group or not member:
            return None
        member_count = sum(1 for current_group_id, _ in self.group_members if current_group_id == group_id)
        return backend.GroupSummary(
            id=group.id,
            name=group.name,
            invite_code=group.invite_code,
            invite_code_expires_at=group.invite_code_expires_at,
            member_count=member_count,
            role=member[0],
            created_at=group.created_at,
            updated_at=group.updated_at,
        )

    async def save_group_document_message(self, record: backend.GroupDocumentMessageRecord) -> None:
        self.group_messages[record.message.id] = record
        group = self.groups[record.message.group_id]
        self.groups[group.id] = backend.GroupRecord(
            id=group.id,
            name=group.name,
            invite_code=group.invite_code,
            invite_code_expires_at=group.invite_code_expires_at,
            created_by=group.created_by,
            created_at=group.created_at,
            updated_at=record.message.sent_at,
        )

    async def list_group_document_messages(self, group_id: str) -> list[backend.GroupDocumentMessage]:
        messages = [record.message for record in self.group_messages.values() if record.message.group_id == group_id]
        return sorted(messages, key=lambda item: (item.sent_at, item.id), reverse=True)

    async def get_group_document_message_record(self, group_id: str, message_id: str) -> backend.GroupDocumentMessageRecord | None:
        record = self.group_messages.get(message_id)
        if record and record.message.group_id == group_id:
            return record
        return None


repo = TestRepository()
repo.reset()
app = backend.app
app.dependency_overrides[backend.get_repository] = lambda: repo
app.state.asr_provider = TestAsrProvider()
app.state.vision_provider = TestVisionProvider()
app.state.text_provider = TestTextProvider()


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


def upload_ready_image(auth: dict, device_id: str, idempotency_prefix: str, content: bytes = b"fake-png-image") -> str:
    checksum = hashlib.sha256(content).hexdigest()
    upload = client.post(
        "/api/v1/assets/upload",
        json={
            "kind": "image",
            "filename": "whiteboard.png",
            "content_type": "image/png",
            "size_bytes": len(content),
            "checksum_sha256": checksum,
            "part_size_bytes": len(content),
        },
        headers=auth_headers(auth, device_id, f"{idempotency_prefix}_upload"),
    )
    assert upload.status_code == 201, upload.text
    uploaded_part = upload_single_part(upload, content)
    asset_id = upload.json()["asset_id"]
    complete = client.post(
        f"/api/v1/assets/{asset_id}/complete",
        json={
            "upload_id": upload.json()["upload_id"],
            "size_bytes": len(content),
            "checksum_sha256": checksum,
            "parts": [uploaded_part],
            "duration_ms": None,
            "width": 320,
            "height": 200,
        },
        headers=auth_headers(auth, device_id, f"{idempotency_prefix}_complete"),
    )
    assert complete.status_code == 200, complete.text
    return asset_id


def create_agent_document(auth: dict, device_id: str = "device_agent") -> tuple[str, str]:
    created_at = iso_now()
    response = client.post(
        "/api/v1/documents",
        json={
            "title": "移动端文档编辑讨论",
            "client_id": device_id,
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
                    "client_id": device_id,
                    "platform": "web",
                    "deleted": False,
                    "props": {"content": "我们现在需要让移动端文档编辑更自然，不要暴露块的概念。"},
                    "source_refs": [],
                }
            ],
        },
        headers=auth_headers(auth, device_id, f"idem_agent_doc_{device_id}"),
    )
    assert response.status_code == 201, response.text
    return response.json()["id"], response.json()["blocks"][0]["props"]["content"]


def agent_payload(document_id: str, text: str, overrides: dict | None = None) -> dict:
    payload = {
        "document_id": document_id,
        "selected_block_ids": ["doc_block_1"],
        "prompt": "把选中内容整理成三个要点",
        "mode": "edit",
        "client_id": "device_agent",
        "tools_version": "mobile-doc-agent-v1",
        "selection": None,
        "context": {
            "title": "移动端文档编辑讨论",
            "blocks": [
                {
                    "id": "doc_block_1",
                    "type": "paragraph",
                    "text": text,
                    "list_style": None,
                    "level": None,
                }
            ],
        },
    }
    if overrides:
        payload.update(overrides)
    return payload


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


def test_postgres_image_asset_save_persists_content_bytea() -> None:
    class FakePool:
        def __init__(self) -> None:
            self.calls = []

        async def execute(self, query: str, *args):
            self.calls.append((query, args))

    now = backend.utcnow()
    fake_pool = FakePool()
    postgres = backend.PostgresRepository.__new__(backend.PostgresRepository)
    postgres.pool = fake_pool
    content = b"fake-png-image"
    record = backend.AssetRecord(
        owner_id="u_test",
        asset=backend.Asset(
            id="asset_image_test",
            kind="image",
            filename="whiteboard.png",
            content_type="image/png",
            size_bytes=len(content),
            checksum_sha256=hashlib.sha256(content).hexdigest(),
            duration_ms=None,
            width=320,
            height=200,
            status="ready",
            url=None,
            created_at=now,
            updated_at=now,
        ),
        upload_id="upload_image_test",
        part_size_bytes=len(content),
        uploaded_parts=[backend.UploadedPart(part_number=1, etag=hashlib.sha256(content).hexdigest(), size_bytes=len(content))],
        content=content,
    )

    asyncio.run(postgres.save_asset(record))

    query, args = fake_pool.calls[0]
    assert "content" in query
    assert args[2] == "image"
    assert args[14] == content


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
    assert "/upload-parts/" in upload.json()["parts"][0]["upload_url"]
    assert "object-storage" not in upload.json()["parts"][0]["upload_url"]
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
        json={"manuscript_id": manuscript_id, "mode": "meeting_minutes", "title": "Minutes", "client_id": "device_test", "optimize_audio": False},
        headers=auth_headers(auth, idempotency_key="idem_convert"),
    )
    assert convert.status_code == 202, convert.text
    assert convert.json()["status"] == "queued"
    convert_task = client.get(f"/api/v1/tasks/{convert.json()['id']}", headers=auth_headers(auth))
    assert convert_task.status_code == 200, convert_task.text
    assert convert_task.json()["status"] == "succeeded"
    document_id = convert_task.json()["result"]["document_id"]
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


def test_image_asset_stream_handles_unicode_filename_and_persists_content() -> None:
    repo.reset()
    auth = register_user("unicode-image@example.com", "device_unicode_image")
    content = b"fake-unicode-png-image"
    checksum = hashlib.sha256(content).hexdigest()
    upload = client.post(
        "/api/v1/assets/upload",
        json={
            "kind": "image",
            "filename": "会议白板.png",
            "content_type": "image/png",
            "size_bytes": len(content),
            "checksum_sha256": checksum,
            "part_size_bytes": len(content),
        },
        headers=auth_headers(auth, "device_unicode_image", "idem_unicode_image_upload"),
    )
    assert upload.status_code == 201, upload.text
    uploaded_part = upload_single_part(upload, content)
    asset_id = upload.json()["asset_id"]
    complete = client.post(
        f"/api/v1/assets/{asset_id}/complete",
        json={
            "upload_id": upload.json()["upload_id"],
            "size_bytes": len(content),
            "checksum_sha256": checksum,
            "parts": [uploaded_part],
            "duration_ms": None,
            "width": 320,
            "height": 200,
        },
        headers=auth_headers(auth, "device_unicode_image", "idem_unicode_image_complete"),
    )
    assert complete.status_code == 200, complete.text
    assert repo.assets[asset_id].content == content
    assert repo.assets[asset_id].asset.kind == "image"
    assert repo.assets[asset_id].asset.status == "ready"

    stream = client.get(f"/api/v1/assets/{asset_id}/stream", headers=auth_headers(auth, "device_unicode_image"))
    assert stream.status_code == 200, stream.text
    assert stream.content == content
    disposition = stream.headers["content-disposition"]
    disposition.encode("latin-1")
    assert "filename*=UTF-8''%E4%BC%9A%E8%AE%AE%E7%99%BD%E6%9D%BF.png" in disposition


def test_group_flow_create_join_send_and_download_document_snapshot() -> None:
    repo.reset()
    alice = register_user("group-alice@example.com", "device_group_alice")
    bob = register_user("group-bob@example.com", "device_group_bob")
    outsider = register_user("group-outsider@example.com", "device_group_outsider")

    create = client.post(
        "/api/v1/groups",
        json={"name": "Project Team", "client_id": "device_group_alice"},
        headers=auth_headers(alice, "device_group_alice", "idem_group_create"),
    )
    assert create.status_code == 201, create.text
    group = create.json()
    assert group["name"] == "Project Team"
    assert group["invite_code"].isdigit()
    assert len(group["invite_code"]) == 6
    assert group["member_count"] == 1
    assert group["role"] == "owner"

    replay = client.post(
        "/api/v1/groups",
        json={"name": "Project Team", "client_id": "device_group_alice"},
        headers=auth_headers(alice, "device_group_alice", "idem_group_create"),
    )
    assert replay.status_code == 201, replay.text
    assert replay.json()["id"] == group["id"]

    alice_groups = client.get("/api/v1/groups", headers=auth_headers(alice, "device_group_alice"))
    assert alice_groups.status_code == 200, alice_groups.text
    assert alice_groups.json()["items"][0]["id"] == group["id"]

    join = client.post(
        "/api/v1/groups/join",
        json={"invite_code": group["invite_code"], "client_id": "device_group_bob"},
        headers=auth_headers(bob, "device_group_bob", "idem_group_join"),
    )
    assert join.status_code == 200, join.text
    assert join.json()["id"] == group["id"]
    assert join.json()["member_count"] == 2
    assert join.json()["role"] == "member"

    repo.groups[group["id"]] = backend.GroupRecord(
        id=group["id"],
        name=group["name"],
        invite_code=group["invite_code"],
        invite_code_expires_at=backend.utcnow() - backend.timedelta(seconds=1),
        created_by=alice["user"]["id"],
        created_at=datetime.fromisoformat(group["created_at"]),
        updated_at=datetime.fromisoformat(group["updated_at"]),
    )
    rejoin = client.post(
        "/api/v1/groups/join",
        json={"invite_code": group["invite_code"], "client_id": "device_group_bob"},
        headers=auth_headers(bob, "device_group_bob", "idem_group_rejoin_expired"),
    )
    assert rejoin.status_code == 200, rejoin.text
    expired_join = client.post(
        "/api/v1/groups/join",
        json={"invite_code": group["invite_code"], "client_id": "device_group_outsider"},
        headers=auth_headers(outsider, "device_group_outsider", "idem_group_expired_join"),
    )
    assert expired_join.status_code == 403

    document = client.post(
        "/api/v1/documents",
        json={"title": "Group Minutes", "client_id": "device_group_alice", "source_manuscript_ids": [], "derived_from": None, "initial_blocks": []},
        headers=auth_headers(alice, "device_group_alice", "idem_group_document"),
    )
    assert document.status_code == 201, document.text
    document_id = document.json()["id"]

    forbidden_send = client.post(
        f"/api/v1/groups/{group['id']}/documents",
        json={"document_id": document_id, "client_id": "device_group_bob"},
        headers=auth_headers(bob, "device_group_bob", "idem_group_forbidden_send"),
    )
    assert forbidden_send.status_code == 403

    send = client.post(
        f"/api/v1/groups/{group['id']}/documents",
        json={"document_id": document_id, "client_id": "device_group_alice"},
        headers=auth_headers(alice, "device_group_alice", "idem_group_send"),
    )
    assert send.status_code == 201, send.text
    message = send.json()
    assert message["group_id"] == group["id"]
    assert message["sender_id"] == alice["user"]["id"]
    assert message["document_title"] == "Group Minutes"

    messages = client.get(f"/api/v1/groups/{group['id']}/messages", headers=auth_headers(bob, "device_group_bob"))
    assert messages.status_code == 200, messages.text
    assert messages.json()["items"][0]["id"] == message["id"]

    download = client.get(
        f"/api/v1/groups/{group['id']}/documents/{message['id']}/download?format=pdf",
        headers=auth_headers(bob, "device_group_bob"),
    )
    assert download.status_code == 200, download.text
    assert download.content.startswith(b"%PDF")
    assert "attachment" in download.headers["content-disposition"]
    assert "Group%20Minutes.pdf" in download.headers["content-disposition"]

    outsider_messages = client.get(f"/api/v1/groups/{group['id']}/messages", headers=auth_headers(outsider, "device_group_outsider"))
    assert outsider_messages.status_code == 403


def test_image_recognition_task_updates_image_block_and_convert_keeps_source_ref() -> None:
    repo.reset()
    auth = register_user("image@example.com", "device_image")
    image_content = b"fake-png-image"
    image_checksum = hashlib.sha256(image_content).hexdigest()
    upload = client.post(
        "/api/v1/assets/upload",
        json={
            "kind": "image",
            "filename": "whiteboard.png",
            "content_type": "image/png",
            "size_bytes": len(image_content),
            "checksum_sha256": image_checksum,
            "part_size_bytes": len(image_content),
        },
        headers=auth_headers(auth, "device_image", "idem_image_upload"),
    )
    assert upload.status_code == 201, upload.text
    assert upload.json()["parts"][0]["upload_url"].startswith("http://testserver/api/v1/assets/")
    uploaded_part = upload_single_part(upload, image_content)
    asset_id = upload.json()["asset_id"]
    complete = client.post(
        f"/api/v1/assets/{asset_id}/complete",
        json={
            "upload_id": upload.json()["upload_id"],
            "size_bytes": len(image_content),
            "checksum_sha256": image_checksum,
            "parts": [uploaded_part],
            "duration_ms": None,
            "width": 320,
            "height": 200,
        },
        headers=auth_headers(auth, "device_image", "idem_image_complete"),
    )
    assert complete.status_code == 200, complete.text
    assert complete.json()["kind"] == "image"
    assert complete.json()["status"] == "ready"
    assert complete.json()["width"] == 320
    assert complete.json()["height"] == 200

    created_at = iso_now()
    manuscript = client.post(
        "/api/v1/manuscripts",
        json={
            "title": "Images",
            "client_id": "device_image",
            "initial_blocks": [
                {
                    "id": "block_image1",
                    "type": "image",
                    "revision": 1,
                    "created_at": created_at,
                    "updated_at": created_at,
                    "author_id": auth["user"]["id"],
                    "client_id": "device_image",
                    "platform": "web",
                    "deleted": False,
                    "props": {"asset_id": asset_id, "caption": "", "width": 320, "height": 200},
                }
            ],
        },
        headers=auth_headers(auth, "device_image", "idem_image_manuscript"),
    )
    assert manuscript.status_code == 201, manuscript.text

    recognize = client.post(
        "/api/v1/tasks/recognize-image",
        json={"asset_id": asset_id, "language": "zh-CN", "client_id": "device_image"},
        headers=auth_headers(auth, "device_image", "idem_image_task"),
    )
    assert recognize.status_code == 202, recognize.text
    task_id = recognize.json()["id"]
    task = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers(auth, "device_image"))
    assert task.status_code == 200, task.text
    assert task.json()["status"] == "succeeded"
    assert task.json()["type"] == "recognize_image"
    assert task.json()["result"] == {"asset_id": asset_id, "caption": "白板架构图", "text": "移动端、PC 端和后端 API 协作。"}
    fetched = client.get(f"/api/v1/manuscripts/{manuscript.json()['id']}", headers=auth_headers(auth, "device_image"))
    image_props = fetched.json()["blocks"][0]["props"]
    assert image_props["caption"] == "白板架构图"
    assert image_props["recognition_task_id"] == task_id
    assert image_props["recognition_generated_at"] is not None

    streamed = client.post(
        "/api/v1/tasks/recognize-image/stream",
        json={"asset_id": asset_id, "language": "zh-CN", "client_id": "device_image"},
        headers=auth_headers(auth, "device_image", "idem_stream_image_task"),
    )
    assert streamed.status_code == 200, streamed.text
    assert "event: delta" in streamed.text
    assert "白板架构图" in streamed.text
    done_task = sse_events(streamed.text, "done")[0]["task"]
    assert done_task["type"] == "recognize_image"
    assert done_task["result"]["asset_id"] == asset_id
    assert done_task["result"]["caption"] == "白板架构图"
    assert done_task["result"]["text"] == "移动端、PC 端和后端 API 协作。"

    convert = client.post(
        "/api/v1/tasks/convert-manuscript",
        json={"manuscript_id": manuscript.json()["id"], "mode": "meeting_minutes", "title": "Image Doc", "client_id": "device_image", "optimize_audio": False},
        headers=auth_headers(auth, "device_image", "idem_image_convert"),
    )
    assert convert.status_code == 202, convert.text
    convert_task = client.get(f"/api/v1/tasks/{convert.json()['id']}", headers=auth_headers(auth, "device_image"))
    assert convert_task.status_code == 200, convert_task.text
    assert convert_task.json()["status"] == "succeeded"
    document = client.get(f"/api/v1/documents/{convert_task.json()['result']['document_id']}", headers=auth_headers(auth, "device_image"))
    assert document.status_code == 200, document.text
    document_block = document.json()["blocks"][0]
    assert document_block["type"] == "image"
    assert document_block["props"]["asset_id"] == asset_id
    assert document_block["props"]["caption"] == "白板架构图"
    assert document_block["source_refs"][0]["block_id"] == "block_image1"


def test_image_recognition_does_not_overwrite_existing_caption() -> None:
    repo.reset()
    auth = register_user("image-caption@example.com", "device_caption")
    asset_id = upload_ready_image(auth, "device_caption", "idem_caption_image")
    created_at = iso_now()
    manuscript = client.post(
        "/api/v1/manuscripts",
        json={
            "title": "Caption",
            "client_id": "device_caption",
            "initial_blocks": [
                {
                    "id": "block_image_caption",
                    "type": "image",
                    "revision": 1,
                    "created_at": created_at,
                    "updated_at": created_at,
                    "author_id": auth["user"]["id"],
                    "client_id": "device_caption",
                    "platform": "web",
                    "deleted": False,
                    "props": {"asset_id": asset_id, "caption": "用户手写描述", "width": 320, "height": 200},
                }
            ],
        },
        headers=auth_headers(auth, "device_caption", "idem_caption_manuscript"),
    )
    assert manuscript.status_code == 201, manuscript.text
    recognize = client.post(
        "/api/v1/tasks/recognize-image",
        json={"asset_id": asset_id, "language": "zh-CN", "client_id": "device_caption"},
        headers=auth_headers(auth, "device_caption", "idem_caption_task"),
    )
    assert recognize.status_code == 202, recognize.text
    task = client.get(f"/api/v1/tasks/{recognize.json()['id']}", headers=auth_headers(auth, "device_caption"))
    assert task.json()["status"] == "succeeded"
    assert task.json()["result"]["caption"] == "白板架构图"
    fetched = client.get(f"/api/v1/manuscripts/{manuscript.json()['id']}", headers=auth_headers(auth, "device_caption"))
    image_props = fetched.json()["blocks"][0]["props"]
    assert image_props["caption"] == "用户手写描述"
    assert image_props["recognition_task_id"] is None


def test_convert_manuscript_async_builds_mixed_blocks_and_warnings() -> None:
    repo.reset()
    TestVisionProvider.reset_calls()
    auth = register_user("convert-mixed@example.com", "device_convert")
    asset_id = upload_ready_image(auth, "device_convert", "idem_convert_image")
    now = backend.utcnow()
    for audio_asset_id in ["asset_audio_local", "asset_audio_empty"]:
        content = f"{audio_asset_id}-bytes".encode("utf-8")
        repo.assets[audio_asset_id] = backend.AssetRecord(
            owner_id=auth["user"]["id"],
            asset=backend.Asset(
                id=audio_asset_id,
                kind="audio",
                filename=f"{audio_asset_id}.wav",
                content_type="audio/wav",
                size_bytes=len(content),
                checksum_sha256=hashlib.sha256(content).hexdigest(),
                duration_ms=1000,
                width=None,
                height=None,
                status="ready",
                url=None,
                created_at=now,
                updated_at=now,
            ),
            upload_id=f"upload_{audio_asset_id}",
            part_size_bytes=len(content),
            uploaded_parts=[],
            content=content,
        )
    created_at = iso_now()
    manuscript = client.post(
        "/api/v1/manuscripts",
        json={
            "title": "Mixed Manuscript",
            "client_id": "device_convert",
            "initial_blocks": [
                {
                    "id": "block_text_convert",
                    "type": "text",
                    "revision": 1,
                    "created_at": created_at,
                    "updated_at": created_at,
                    "author_id": auth["user"]["id"],
                    "client_id": "device_convert",
                    "platform": "web",
                    "deleted": False,
                    "props": {"content": "会议目标：推进移动端。"},
                },
                {
                    "id": "block_audio_convert",
                    "type": "audio",
                    "revision": 1,
                    "created_at": created_at,
                    "updated_at": created_at,
                    "author_id": auth["user"]["id"],
                    "client_id": "device_convert",
                    "platform": "web",
                    "deleted": False,
                    "props": {"asset_id": "asset_audio_local", "duration_ms": 1000, "transcript": "嗯我们就是今天讨论移动端", "speaker_segments": []},
                },
                {
                    "id": "block_audio_empty",
                    "type": "audio",
                    "revision": 1,
                    "created_at": created_at,
                    "updated_at": created_at,
                    "author_id": auth["user"]["id"],
                    "client_id": "device_convert",
                    "platform": "web",
                    "deleted": False,
                    "props": {"asset_id": "asset_audio_empty", "duration_ms": 1000, "transcript": "", "speaker_segments": []},
                },
                {
                    "id": "block_image_convert",
                    "type": "image",
                    "revision": 1,
                    "created_at": created_at,
                    "updated_at": created_at,
                    "author_id": auth["user"]["id"],
                    "client_id": "device_convert",
                    "platform": "web",
                    "deleted": False,
                    "props": {"asset_id": asset_id, "caption": "", "width": 320, "height": 200},
                },
                {
                    "id": "block_hw_convert",
                    "type": "handwriting",
                    "revision": 1,
                    "created_at": created_at,
                    "updated_at": created_at,
                    "author_id": auth["user"]["id"],
                    "client_id": "device_convert",
                    "platform": "web",
                    "deleted": False,
                    "props": {
                        "strokes": [
                            {
                                "id": "stroke_1",
                                "tool": "pen",
                                "color": "#111111",
                                "width": 2,
                                "points": [
                                    {"x": 10, "y": 10, "t": 0, "pressure": 0.5},
                                    {"x": 120, "y": 30, "t": 16, "pressure": 0.5},
                                ],
                            }
                        ],
                        "image_asset_id": None,
                        "ai_text": "",
                    },
                },
            ],
        },
        headers=auth_headers(auth, "device_convert", "idem_convert_manuscript"),
    )
    assert manuscript.status_code == 201, manuscript.text
    convert = client.post(
        "/api/v1/tasks/convert-manuscript",
        json={"manuscript_id": manuscript.json()["id"], "mode": "meeting_minutes", "title": "Mixed Doc", "client_id": "device_convert", "optimize_audio": True},
        headers=auth_headers(auth, "device_convert", "idem_convert_task"),
    )
    assert convert.status_code == 202, convert.text
    assert convert.json()["status"] == "queued"
    task = client.get(f"/api/v1/tasks/{convert.json()['id']}", headers=auth_headers(auth, "device_convert"))
    assert task.status_code == 200, task.text
    assert task.json()["status"] == "succeeded"
    assert task.json()["progress"]["stage"] == "completed"
    assert task.json()["progress"]["current"] == task.json()["progress"]["total"]
    warning_codes = {warning["code"] for warning in task.json()["result"].get("warnings", [])}
    assert "audio_transcript_missing" in warning_codes
    document = client.get(f"/api/v1/documents/{task.json()['result']['document_id']}", headers=auth_headers(auth, "device_convert"))
    assert document.status_code == 200, document.text
    blocks = document.json()["blocks"]
    assert blocks[0]["type"] == "paragraph"
    assert blocks[0]["props"]["content"] == "会议目标：推进移动端。"
    assert blocks[1]["props"]["content"] == "发言：我们今天讨论移动端"
    assert blocks[2]["type"] == "image"
    assert blocks[2]["props"]["asset_id"] == asset_id
    assert blocks[2]["props"]["caption"] == "白板架构图"
    assert blocks[3]["type"] == "image"
    assert blocks[3]["props"]["caption"] == "手写流程图"
    assert blocks[4]["type"] == "heading"
    assert blocks[4]["props"]["content"] == "移动端优先推进"
    assert {block["source_refs"][0]["block_id"] for block in blocks if block["source_refs"]} >= {"block_text_convert", "block_audio_convert", "block_image_convert", "block_hw_convert"}
    rendered = next(record for record in repo.assets.values() if record.asset.filename == "block_hw_convert.png")
    assert rendered.asset.content_type == "image/png"
    assert rendered.asset.width >= 320
    assert rendered.asset.height >= 120
    assert rendered.content and rendered.content.startswith(b"\x89PNG\r\n\x1a\n")
    handwriting_calls = [call for call in TestVisionProvider.calls if call.get("prompt")]
    assert len(handwriting_calls) == 1
    assert handwriting_calls[0]["content_type"] == "image/png"


def test_handwriting_convert_does_not_send_svg_to_vision() -> None:
    repo.reset()
    TestVisionProvider.reset_calls()
    auth = register_user("convert-svg@example.com", "device_convert_svg")
    now = backend.utcnow()
    svg_content = b'<svg xmlns="http://www.w3.org/2000/svg"><text>SVG</text></svg>'
    svg_asset_id = "asset_hw_svg"
    repo.assets[svg_asset_id] = backend.AssetRecord(
        owner_id=auth["user"]["id"],
        asset=backend.Asset(
            id=svg_asset_id,
            kind="image",
            filename="handwriting.svg",
            content_type="image/svg+xml",
            size_bytes=len(svg_content),
            checksum_sha256=hashlib.sha256(svg_content).hexdigest(),
            duration_ms=None,
            width=320,
            height=120,
            status="ready",
            url=None,
            created_at=now,
            updated_at=now,
        ),
        upload_id="upload_hw_svg",
        part_size_bytes=len(svg_content),
        uploaded_parts=[],
        content=svg_content,
    )
    created_at = iso_now()
    manuscript = client.post(
        "/api/v1/manuscripts",
        json={
            "title": "SVG Handwriting",
            "client_id": "device_convert_svg",
            "initial_blocks": [
                {
                    "id": "block_hw_svg",
                    "type": "handwriting",
                    "revision": 1,
                    "created_at": created_at,
                    "updated_at": created_at,
                    "author_id": auth["user"]["id"],
                    "client_id": "device_convert_svg",
                    "platform": "web",
                    "deleted": False,
                    "props": {"strokes": [], "image_asset_id": svg_asset_id, "ai_text": ""},
                }
            ],
        },
        headers=auth_headers(auth, "device_convert_svg", "idem_svg_manuscript"),
    )
    assert manuscript.status_code == 201, manuscript.text

    convert = client.post(
        "/api/v1/tasks/convert-manuscript",
        json={"manuscript_id": manuscript.json()["id"], "mode": "meeting_minutes", "title": "SVG Doc", "client_id": "device_convert_svg", "optimize_audio": False},
        headers=auth_headers(auth, "device_convert_svg", "idem_svg_convert"),
    )
    assert convert.status_code == 202, convert.text
    task = client.get(f"/api/v1/tasks/{convert.json()['id']}", headers=auth_headers(auth, "device_convert_svg"))
    assert task.status_code == 200, task.text
    assert task.json()["status"] == "succeeded"
    warning_codes = {warning["code"] for warning in task.json()["result"].get("warnings", [])}
    assert "handwriting_render_failed" in warning_codes
    assert TestVisionProvider.calls == []


def test_agent_stream_returns_structured_tool_calls_without_mutating_document() -> None:
    repo.reset()
    TestTextProvider.set_result(
        {
            "summary": "将选中段落整理为 3 条要点",
            "tool_calls": [
                {
                    "name": "convert_to_list",
                    "args": {"block_id": "doc_block_1", "style": "bullet", "items": ["第一点", "第二点", "第三点"]},
                }
            ],
        }
    )
    auth = register_user("agent@example.com", "device_agent")
    document_id, original_text = create_agent_document(auth)
    with client.stream(
        "POST",
        "/api/v1/ai/agent/chat",
        json=agent_payload(document_id, original_text),
        headers=auth_headers(auth, "device_agent", "idem_agent_chat"),
    ) as response:
        assert response.status_code == 200, response.text
        assert response.headers["content-type"].startswith("text/event-stream")
        events = response.read().decode("utf-8")
    assert sse_events(events, "status")[0] == {"message": "正在分析选中内容"}
    assert sse_events(events, "delta") == [{"text": "正在生成编辑建议..."}]
    result = sse_events(events, "result")[0]
    assert result["summary"] == "将选中段落整理为 3 条要点"
    assert result["tool_calls"][0] == {"name": "convert_to_list", "args": {"block_id": "doc_block_1", "style": "bullet", "items": ["第一点", "第二点", "第三点"]}}
    assert sse_events(events, "done")[0]["usage"] == {"input_tokens": 12, "output_tokens": 8}

    stored = client.get(f"/api/v1/documents/{document_id}", headers=auth_headers(auth, "device_agent"))
    assert stored.status_code == 200, stored.text
    assert stored.json()["revision"] == 1
    assert stored.json()["blocks"][0]["props"]["content"] == original_text


def test_agent_non_stream_uses_idempotency_cache() -> None:
    repo.reset()
    TestTextProvider.set_result({"summary": "改写完成", "tool_calls": [{"name": "replace_block_text", "args": {"block_id": "doc_block_1", "content": "改写后的整段文本"}}]})
    auth = register_user("agent-json@example.com", "device_agent")
    document_id, text = create_agent_document(auth)
    response = client.post(
        "/api/v1/ai/agent/chat?stream=false",
        json=agent_payload(document_id, text),
        headers=auth_headers(auth, "device_agent", "idem_agent_json"),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["summary"] == "改写完成"
    assert body["tool_calls"][0]["name"] == "replace_block_text"
    assert body["usage"] == {"input_tokens": 12, "output_tokens": 8}

    TestTextProvider.set_result({"summary": "不应返回", "tool_calls": []})
    replay = client.post(
        "/api/v1/ai/agent/chat?stream=false",
        json=agent_payload(document_id, text),
        headers=auth_headers(auth, "device_agent", "idem_agent_json"),
    )
    assert replay.status_code == 200, replay.text
    assert replay.json() == body


def test_agent_rejects_invalid_request_context() -> None:
    repo.reset()
    auth = register_user("agent-invalid@example.com", "device_agent")
    document_id, text = create_agent_document(auth)
    invalid_mode = client.post(
        "/api/v1/ai/agent/chat",
        json=agent_payload(document_id, text, {"mode": "rewrite"}),
        headers=auth_headers(auth, "device_agent", "idem_agent_invalid_mode"),
    )
    assert invalid_mode.status_code == 400, invalid_mode.text
    assert invalid_mode.json()["error"]["code"] == "invalid_request"

    invalid_context = client.post(
        "/api/v1/ai/agent/chat",
        json=agent_payload(document_id, text, {"context": {"title": "移动端文档编辑讨论", "blocks": [{"id": "missing", "type": "paragraph", "text": text, "list_style": None, "level": None}]}}),
        headers=auth_headers(auth, "device_agent", "idem_agent_invalid_context"),
    )
    assert invalid_context.status_code == 422, invalid_context.text
    assert invalid_context.json()["error"]["code"] == "validation_error"


def test_agent_returns_error_for_invalid_model_tool_protocol() -> None:
    repo.reset()
    TestTextProvider.set_result({"summary": "错误列表样式", "tool_calls": [{"name": "convert_to_list", "args": {"block_id": "doc_block_1", "style": "number", "items": ["第一点"]}}]})
    auth = register_user("agent-tool-invalid@example.com", "device_agent")
    document_id, text = create_agent_document(auth)
    with client.stream(
        "POST",
        "/api/v1/ai/agent/chat",
        json=agent_payload(document_id, text),
        headers=auth_headers(auth, "device_agent", "idem_agent_invalid_tool"),
    ) as response:
        assert response.status_code == 200, response.text
        events = response.read().decode("utf-8")
    assert sse_events(events, "error")[0] == {"code": "ai_unavailable", "message": "AI 输出不符合工具协议", "retryable": True}


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
    convert_request = schema["components"]["schemas"]["ConvertManuscriptRequest"]
    assert "optimize_audio" in convert_request["required"]
    assert convert_request["properties"]["optimize_audio"]["type"] == "boolean"
    assert "/api/v1/tasks/recognize-image" in schema["paths"]


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

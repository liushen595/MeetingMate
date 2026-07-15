from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import math
import os
import re
import secrets
import uuid
import zipfile
from contextlib import asynccontextmanager
from dataclasses import dataclass, field as dataclass_field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, AsyncIterator, Literal
from urllib.parse import quote, urlencode

from fastapi import BackgroundTasks, Depends, FastAPI, Header, Query, Request, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.routing import APIRouter
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.websockets import WebSocket, WebSocketDisconnect
from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, EmailStr, Field, TypeAdapter, model_validator
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import HTTPConnection

from app.asr import AsrProvider, AsrProviderError, AsrResult, provider_from_environment as asr_provider_from_environment, result_from_text, stream_delta
from app.database import DatabaseSettings, DatabaseState, check_database, close_database, connect_database, load_database_settings
from app.text import TextProvider, local_clean_transcript, provider_from_environment as text_provider_from_environment
from app.vision import VisionProvider, VisionProviderError, VisionResult, provider_from_environment as vision_provider_from_environment, result_from_text as vision_result_from_text


API_PREFIX = "/api/v1"
BACKEND_ROOT = Path(__file__).resolve().parents[1]
ACCESS_TOKEN_SECONDS = 30 * 60
REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60
IDEMPOTENCY_SECONDS = 24 * 60 * 60
MAX_LIMIT = 100
DEFAULT_LIMIT = 20
MAX_OPERATIONS = 100
MAX_BLOCK_BYTES = 256 * 1024
MAX_HANDWRITING_POINTS = 5000
MAX_CLIENT_TIME_SKEW_SECONDS = 24 * 60 * 60
GROUP_INVITE_CODE_SECONDS = 24 * 60 * 60
MAX_INVITE_CODE_ATTEMPTS = 10
DEFAULT_CORS_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1|10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(?::\d+)?$"
HANDWRITING_BITMAP_CONTENT_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/bmp"}
HANDWRITING_RENDER_SCALE = 2
HANDWRITING_RECOGNITION_PROMPT = """
请识别这张手写手稿图片。
只输出 JSON，不要输出 Markdown，不要输出解释。
recognized_text 是图中可读手写正文，尽量按原始换行返回。
has_keepable_drawing 表示图片中是否有值得在正式文档中保留的手绘图、示意图、流程图、结构图或草图。
如果只有手写文字，没有图示，has_keepable_drawing 必须为 false。
drawing_caption 是可保留手绘图的一句话说明；没有可保留绘图时返回空字符串。
confidence 是 0 到 1 的识别置信度。
不要编造看不见的信息。
返回格式：{"recognized_text":"","has_keepable_drawing":false,"drawing_caption":"","confidence":0}
""".strip()


Platform = Literal["ios", "android", "mac", "windows", "web"]
Permission = Literal["owner", "editor", "viewer"]
GroupRole = Literal["owner", "member"]
AssetKind = Literal["audio", "image", "export", "attachment"]
AssetStatus = Literal["pending_upload", "uploaded", "ready", "failed"]
TaskType = Literal["convert_manuscript", "asr_audio", "recognize_image", "export_document", "ai_rewrite"]
TaskStatus = Literal["queued", "processing", "succeeded", "failed", "cancelled"]
TaskStage = Literal[
    "queued",
    "uploading",
    "asr",
    "diarization",
    "llm_parse",
    "document_build",
    "exporting",
    "completed",
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ErrorBody(StrictModel):
    code: str
    message: str
    details: dict[str, Any] | None = None
    request_id: str


class ErrorResponse(StrictModel):
    error: ErrorBody


class HealthResponse(StrictModel):
    status: Literal["ok", "degraded"]
    database: Literal["ok", "unavailable"]
    pgvector: Literal["enabled", "disabled"] | None = None


class APIError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


class ContractJSONResponse(JSONResponse):
    media_type = "application/json; charset=utf-8"


@dataclass(frozen=True)
class AppSettings:
    cors_origins: list[str]
    cors_origin_regex: str | None
    allowed_hosts: list[str]
    asset_upload_url_mode: str | None
    api_public_base_url: str | None
    asr_provider: str
    vision_provider: str
    database: DatabaseSettings


def parse_env_list(name: str) -> list[str]:
    raw = os.getenv(name, "")
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        value = raw.split(",")
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def load_settings() -> AppSettings:
    if os.getenv("MEETINGMATE_SKIP_DOTENV") != "1":
        load_dotenv(BACKEND_ROOT / ".env")
    return AppSettings(
        cors_origins=parse_env_list("CORS_ORIGINS"),
        cors_origin_regex=os.getenv("CORS_ORIGIN_REGEX") or DEFAULT_CORS_ORIGIN_REGEX,
        allowed_hosts=parse_env_list("ALLOWED_HOSTS"),
        asset_upload_url_mode=os.getenv("ASSET_UPLOAD_URL_MODE") or "api",
        api_public_base_url=os.getenv("API_PUBLIC_BASE_URL") or None,
        asr_provider=os.getenv("ASR_PROVIDER") or "dashscope",
        vision_provider=os.getenv("VISION_PROVIDER") or "dashscope",
        database=load_database_settings(),
    )


settings = load_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.database = await connect_database(settings.database)
    app.state.repository = PostgresRepository(app.state.database)
    app.state.asr_provider = build_asr_provider()
    app.state.vision_provider = build_vision_provider()
    app.state.text_provider = build_text_provider()
    try:
        yield
    finally:
        await close_database(app.state.database)


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def make_token(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(32)}"


def make_invite_code() -> str:
    return f"{secrets.randbelow(900000) + 100000:06d}"


def build_asr_provider() -> AsrProvider:
    return asr_provider_from_environment(settings.asr_provider)


def build_vision_provider() -> VisionProvider:
    return vision_provider_from_environment(settings.vision_provider)


def build_text_provider() -> TextProvider:
    return text_provider_from_environment()


def get_asr_provider(request: Request) -> AsrProvider:
    provider = getattr(request.app.state, "asr_provider", None)
    if provider is None:
        provider = build_asr_provider()
        request.app.state.asr_provider = provider
    return provider


def get_vision_provider(request: Request) -> VisionProvider:
    provider = getattr(request.app.state, "vision_provider", None)
    if provider is None:
        provider = build_vision_provider()
        request.app.state.vision_provider = provider
    return provider


def get_text_provider(request: Request) -> TextProvider:
    provider = getattr(request.app.state, "text_provider", None)
    if provider is None:
        provider = build_text_provider()
        request.app.state.text_provider = provider
    return provider


def password_hash(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return f"{salt}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        salt, expected = encoded.split("$", 1)
    except ValueError:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return secrets.compare_digest(digest.hex(), expected)


def hash_request_body(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def public_api_base_url(request: Request) -> str:
    if settings.api_public_base_url:
        return settings.api_public_base_url.rstrip("/")
    return str(request.base_url).rstrip("/")


def upload_part_signature(asset_id: str, upload_id: str, part_number: int, expires_at: int) -> str:
    payload = f"{asset_id}:{upload_id}:{part_number}:{expires_at}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def make_api_upload_url(request: Request, asset_id: str, upload_id: str, part_number: int, expires_at: datetime) -> str:
    expires_at_ts = int(expires_at.timestamp())
    query = urlencode(
        {
            "upload_id": upload_id,
            "expires_at": str(expires_at_ts),
            "signature": upload_part_signature(asset_id, upload_id, part_number, expires_at_ts),
        }
    )
    return f"{public_api_base_url(request)}{API_PREFIX}/assets/{quote(asset_id, safe='')}/upload-parts/{part_number}?{query}"


def make_asset_stream_url(request: Request, asset_id: str) -> str:
    return f"{public_api_base_url(request)}{API_PREFIX}/assets/{quote(asset_id, safe='')}/stream"


def encode_cursor(offset: int) -> str:
    payload = json.dumps({"offset": offset}, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii")


def decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        payload = base64.urlsafe_b64decode(cursor.encode("ascii"))
        value = json.loads(payload.decode("utf-8"))
        offset = int(value["offset"])
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        raise APIError(status.HTTP_400_BAD_REQUEST, "invalid_request", "Cursor is invalid.")
    if offset < 0:
        raise APIError(status.HTTP_400_BAD_REQUEST, "invalid_request", "Cursor is invalid.")
    return offset


def paginate(items: list[Any], limit: int, cursor: str | None) -> tuple[list[Any], str | None]:
    start = decode_cursor(cursor)
    end = start + limit
    page = items[start:end]
    next_cursor = encode_cursor(end) if end < len(items) else None
    return page, next_cursor


def ensure_client_time(value: datetime, field_name: str) -> None:
    if value.tzinfo is None:
        raise APIError(status.HTTP_422_UNPROCESSABLE_ENTITY, "validation_error", f"{field_name} must include timezone.")
    delta = abs((utcnow() - value.astimezone(timezone.utc)).total_seconds())
    if delta > MAX_CLIENT_TIME_SKEW_SECONDS:
        raise APIError(status.HTTP_422_UNPROCESSABLE_ENTITY, "validation_error", f"{field_name} is outside the allowed 24 hour window.")


def dump_model(value: BaseModel | dict[str, Any]) -> dict[str, Any]:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    return value


def validation_error(message: str, details: dict[str, Any] | None = None) -> APIError:
    return APIError(status.HTTP_422_UNPROCESSABLE_ENTITY, "validation_error", message, details)


class DeviceInput(StrictModel):
    client_id: str
    platform: Platform
    app_version: str
    name: str


class Device(StrictModel):
    id: str
    platform: Platform
    app_version: str
    name: str
    last_seen_at: datetime
    created_at: datetime


class User(StrictModel):
    id: str
    email: EmailStr
    name: str
    avatar_url: str | None = None
    created_at: datetime


class RegisterRequest(StrictModel):
    email: EmailStr
    password: str = Field(min_length=1)
    name: str = Field(min_length=1)
    device: DeviceInput


class LoginRequest(StrictModel):
    email: EmailStr
    password: str = Field(min_length=1)
    device: DeviceInput


class RefreshRequest(StrictModel):
    refresh_token: str
    client_id: str


class LogoutRequest(StrictModel):
    client_id: str
    refresh_token: str


class AuthResponse(StrictModel):
    access_token: str
    access_token_expires_in: int
    refresh_token: str
    refresh_token_expires_in: int
    user: User


class DeviceListResponse(StrictModel):
    items: list[Device]
    next_cursor: str | None
    sort_by: Literal["last_seen_at,id"] = "last_seen_at,id"
    sort_order: Literal["desc"] = "desc"


class SpeakerSegment(StrictModel):
    speaker_id: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    text: str
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def validate_range(self) -> "SpeakerSegment":
        if self.end_ms < self.start_ms:
            raise ValueError("end_ms must be greater than or equal to start_ms")
        return self


class StrokePoint(StrictModel):
    x: float
    y: float
    t: int = Field(ge=0)
    pressure: float | None = Field(default=None, ge=0, le=1)


class Stroke(StrictModel):
    id: str
    tool: Literal["pen", "pencil", "marker", "eraser"] | str
    color: str
    width: float = Field(gt=0)
    points: list[StrokePoint]


class TextProps(StrictModel):
    content: str


class AudioProps(StrictModel):
    asset_id: str
    duration_ms: int = Field(ge=0)
    transcript: str
    speaker_segments: list[SpeakerSegment] = Field(default_factory=list)
    asr_task_id: str | None = None
    asr_generated_at: datetime | None = None


class ImageProps(StrictModel):
    asset_id: str
    caption: str | None = ""
    width: int | None = Field(default=None, ge=0)
    height: int | None = Field(default=None, ge=0)
    recognition_task_id: str | None = None
    recognition_generated_at: datetime | None = None


class HandwritingProps(StrictModel):
    strokes: list[Stroke] = Field(default_factory=list)
    image_asset_id: str | None = None
    ai_text: str | None = ""


class BaseBlock(StrictModel):
    id: str
    revision: int = Field(ge=0)
    created_at: datetime
    updated_at: datetime
    author_id: str
    client_id: str
    platform: Platform
    deleted: bool = False


class ManuscriptTextBlock(BaseBlock):
    type: Literal["text"]
    props: TextProps


class ManuscriptAudioBlock(BaseBlock):
    type: Literal["audio"]
    props: AudioProps


class ManuscriptImageBlock(BaseBlock):
    type: Literal["image"]
    props: ImageProps


class ManuscriptHandwritingBlock(BaseBlock):
    type: Literal["handwriting"]
    props: HandwritingProps


ManuscriptBlock = Annotated[
    ManuscriptTextBlock | ManuscriptAudioBlock | ManuscriptImageBlock | ManuscriptHandwritingBlock,
    Field(discriminator="type"),
]


class SourceRange(StrictModel):
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_range(self) -> "SourceRange":
        if self.end_ms < self.start_ms:
            raise ValueError("end_ms must be greater than or equal to start_ms")
        return self


class SourceRegion(StrictModel):
    x: float
    y: float
    w: float = Field(ge=0)
    h: float = Field(ge=0)


class SourceRef(StrictModel):
    manuscript_id: str
    block_id: str
    range: SourceRange | None = None
    region: SourceRegion | None = None


class HeadingProps(StrictModel):
    level: int = Field(ge=1, le=6)
    content: str


class ListProps(StrictModel):
    style: Literal["bullet", "numbered"]
    items: list[str]


class QuoteProps(StrictModel):
    content: str


class TableProps(StrictModel):
    rows: list[list[str]]


class CodeProps(StrictModel):
    language: str
    content: str


class DocumentBaseBlock(BaseBlock):
    source_refs: list[SourceRef] = Field(default_factory=list)


class DocumentParagraphBlock(DocumentBaseBlock):
    type: Literal["paragraph"]
    props: TextProps


class DocumentHeadingBlock(DocumentBaseBlock):
    type: Literal["heading"]
    props: HeadingProps


class DocumentListBlock(DocumentBaseBlock):
    type: Literal["list"]
    props: ListProps


class DocumentQuoteBlock(DocumentBaseBlock):
    type: Literal["quote"]
    props: QuoteProps


class DocumentImageBlock(DocumentBaseBlock):
    type: Literal["image"]
    props: ImageProps


class DocumentTableBlock(DocumentBaseBlock):
    type: Literal["table"]
    props: TableProps


class DocumentCodeBlock(DocumentBaseBlock):
    type: Literal["code"]
    props: CodeProps


DocumentBlock = Annotated[
    DocumentParagraphBlock
    | DocumentHeadingBlock
    | DocumentListBlock
    | DocumentQuoteBlock
    | DocumentImageBlock
    | DocumentTableBlock
    | DocumentCodeBlock,
    Field(discriminator="type"),
]


class Asset(StrictModel):
    id: str
    kind: AssetKind
    filename: str
    content_type: str
    size_bytes: int = Field(ge=0)
    checksum_sha256: str
    duration_ms: int | None = Field(default=None, ge=0)
    width: int | None = Field(default=None, ge=0)
    height: int | None = Field(default=None, ge=0)
    status: AssetStatus
    url: str | None = None
    created_at: datetime
    updated_at: datetime


class UploadPart(StrictModel):
    part_number: int = Field(ge=1)
    upload_url: str
    headers: dict[str, str]
    expires_at: datetime


class UploadedPart(StrictModel):
    part_number: int = Field(ge=1)
    etag: str
    size_bytes: int = Field(ge=0)


class AssetUploadRequest(StrictModel):
    kind: AssetKind
    filename: str
    content_type: str
    size_bytes: int = Field(gt=0)
    checksum_sha256: str
    part_size_bytes: int = Field(gt=0)


class AssetUploadResponse(StrictModel):
    asset_id: str
    upload_id: str
    part_size_bytes: int
    parts: list[UploadPart]


class AssetUploadPartsResponse(StrictModel):
    asset_id: str
    upload_id: str
    part_size_bytes: int
    uploaded_parts: list[UploadedPart]
    missing_parts: list[UploadPart]


class AssetCompleteRequest(StrictModel):
    upload_id: str
    size_bytes: int = Field(gt=0)
    checksum_sha256: str
    parts: list[UploadedPart]
    duration_ms: int | None = Field(default=None, ge=0)
    width: int | None = Field(default=None, ge=0)
    height: int | None = Field(default=None, ge=0)


class Manuscript(StrictModel):
    id: str
    title: str
    owner_id: str
    revision: int
    blocks: list[ManuscriptBlock]
    created_at: datetime
    updated_at: datetime
    deleted: bool = False
    deleted_at: datetime | None = None


class ManuscriptSummary(StrictModel):
    id: str
    title: str
    owner_id: str
    revision: int
    created_at: datetime
    updated_at: datetime


class ManuscriptListResponse(StrictModel):
    items: list[ManuscriptSummary]
    next_cursor: str | None
    sort_by: Literal["updated_at,id"] = "updated_at,id"
    sort_order: Literal["desc"] = "desc"


class ManuscriptCreateRequest(StrictModel):
    title: str
    client_id: str
    initial_blocks: list[ManuscriptBlock] = Field(default_factory=list)


class DerivedFrom(StrictModel):
    manuscript_id: str
    task_id: str
    mode: Literal["meeting_minutes", "todo_list", "article_draft"]
    converted_at: datetime


class Document(StrictModel):
    id: str
    title: str
    owner_id: str
    source_manuscript_ids: list[str]
    derived_from: DerivedFrom | None
    revision: int
    blocks: list[DocumentBlock]
    permission: Permission = "owner"
    created_at: datetime
    updated_at: datetime


class DocumentSummary(StrictModel):
    id: str
    title: str
    owner_id: str
    source_manuscript_ids: list[str]
    derived_from: DerivedFrom | None
    revision: int
    permission: Permission = "owner"
    created_at: datetime
    updated_at: datetime


class DocumentListResponse(StrictModel):
    items: list[DocumentSummary]
    next_cursor: str | None
    sort_by: Literal["updated_at,id"] = "updated_at,id"
    sort_order: Literal["desc"] = "desc"


class DocumentCreateRequest(StrictModel):
    title: str
    client_id: str
    source_manuscript_ids: list[str] = Field(default_factory=list)
    derived_from: DerivedFrom | None = None
    initial_blocks: list[DocumentBlock] = Field(default_factory=list)


class GroupCreateRequest(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    client_id: str


class GroupJoinRequest(StrictModel):
    invite_code: str = Field(pattern=r"^\d{6}$")
    client_id: str


class GroupSummary(StrictModel):
    id: str
    name: str
    invite_code: str
    invite_code_expires_at: datetime
    member_count: int = Field(ge=0)
    role: GroupRole
    created_at: datetime
    updated_at: datetime


class GroupListResponse(StrictModel):
    items: list[GroupSummary]
    next_cursor: str | None
    sort_by: Literal["updated_at,id"] = "updated_at,id"
    sort_order: Literal["desc"] = "desc"


class GroupDocumentSendRequest(StrictModel):
    document_id: str
    client_id: str


class GroupDocumentMessage(StrictModel):
    id: str
    group_id: str
    sender_id: str
    sender_name: str
    document_id: str
    document_title: str
    document_revision: int
    sent_at: datetime


class GroupMessageListResponse(StrictModel):
    items: list[GroupDocumentMessage]
    next_cursor: str | None
    sort_by: Literal["sent_at,id"] = "sent_at,id"
    sort_order: Literal["desc"] = "desc"


class SyncOperationBase(StrictModel):
    op_id: str
    type: Literal["upsert_block", "delete_block", "move_block", "restore_block"]
    block_id: str | None = None
    before_block_id: str | None = None
    after_block_id: str | None = None
    created_at: datetime


class ManuscriptSyncOperation(SyncOperationBase):
    block: ManuscriptBlock | None = None

    @model_validator(mode="after")
    def validate_operation(self) -> "ManuscriptSyncOperation":
        validate_operation_shape(self.type, self.block, self.block_id, self.before_block_id, self.after_block_id)
        return self


class DocumentSyncOperation(SyncOperationBase):
    block: DocumentBlock | None = None

    @model_validator(mode="after")
    def validate_operation(self) -> "DocumentSyncOperation":
        validate_operation_shape(self.type, self.block, self.block_id, self.before_block_id, self.after_block_id)
        return self


def validate_operation_shape(
    op_type: str,
    block: Any,
    block_id: str | None,
    before_block_id: str | None,
    after_block_id: str | None,
) -> None:
    if op_type == "upsert_block" and block is None:
        raise ValueError("upsert_block requires block")
    if op_type in {"delete_block", "restore_block"} and block_id is None:
        raise ValueError(f"{op_type} requires block_id")
    if op_type == "move_block":
        if block_id is None:
            raise ValueError("move_block requires block_id")
        if before_block_id is None and after_block_id is None:
            raise ValueError("move_block requires before_block_id or after_block_id")


class ManuscriptSyncRequest(StrictModel):
    client_id: str
    base_revision: int = Field(ge=0)
    operations: list[ManuscriptSyncOperation] = Field(max_length=MAX_OPERATIONS)


class DocumentSyncRequest(StrictModel):
    client_id: str
    base_revision: int = Field(ge=0)
    operations: list[DocumentSyncOperation] = Field(max_length=MAX_OPERATIONS)


class SyncConflict(StrictModel):
    op_id: str
    block_id: str
    reason: Literal[
        "block_updated_by_other_client",
        "block_deleted_by_other_client",
        "invalid_block_order",
        "unsupported_merge",
    ]
    server_block: dict[str, Any] | None = None
    client_block: dict[str, Any] | None = None


class ManuscriptSyncResponse(StrictModel):
    resource_id: str
    revision: int
    applied_op_ids: list[str]
    conflicts: list[SyncConflict]
    blocks: list[ManuscriptBlock]


class DocumentSyncResponse(StrictModel):
    resource_id: str
    revision: int
    applied_op_ids: list[str]
    conflicts: list[SyncConflict]
    blocks: list[DocumentBlock]


class ManuscriptBlockListResponse(StrictModel):
    items: list[ManuscriptBlock]
    next_cursor: str | None
    sort_by: Literal["order_key,id"] = "order_key,id"
    sort_order: Literal["asc"] = "asc"
    revision: int


class DocumentBlockListResponse(StrictModel):
    items: list[DocumentBlock]
    next_cursor: str | None
    sort_by: Literal["order_key,id"] = "order_key,id"
    sort_order: Literal["asc"] = "asc"
    revision: int


class TaskProgress(StrictModel):
    stage: TaskStage
    current: int = Field(ge=0)
    total: int = Field(ge=0)
    message: str


class TaskError(StrictModel):
    code: str
    message: str
    retryable: bool


class Task(StrictModel):
    id: str
    type: TaskType
    status: TaskStatus
    progress: TaskProgress
    result: dict[str, Any] | None = None
    error: TaskError | None = None
    retry_count: int = 0
    billing: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime


class ConvertManuscriptRequest(StrictModel):
    manuscript_id: str
    mode: Literal["meeting_minutes", "todo_list", "article_draft"]
    title: str
    client_id: str
    optimize_audio: bool


class AsrAudioRequest(StrictModel):
    asset_id: str
    language: str
    enable_diarization: bool
    client_id: str


class RecognizeImageRequest(StrictModel):
    asset_id: str
    language: str = "zh-CN"
    client_id: str


class ExportRequest(StrictModel):
    document_id: str
    format: Literal["pdf", "docx"]
    client_id: str


class ExportDownloadResponse(StrictModel):
    download_url: str
    expires_at: datetime


class AiChatRequest(StrictModel):
    document_id: str
    selected_block_ids: list[str] = Field(default_factory=list)
    prompt: str
    mode: Literal["rewrite", "summary", "continue", "qa"] | str
    client_id: str


class DocumentVersion(StrictModel):
    id: str
    document_id: str
    revision: int
    title: str
    created_by: str
    created_at: datetime


class DocumentVersionListResponse(StrictModel):
    items: list[DocumentVersion]
    next_cursor: str | None
    sort_by: Literal["created_at,id"] = "created_at,id"
    sort_order: Literal["desc"] = "desc"


class RestoreVersionRequest(StrictModel):
    client_id: str
    base_revision: int = Field(ge=0)


class ShareLinkRequest(StrictModel):
    permission: Permission
    expires_at: datetime


class ShareLink(StrictModel):
    id: str
    document_id: str
    permission: Permission
    url: str
    expires_at: datetime
    created_at: datetime


class DeletedManuscriptResponse(StrictModel):
    id: str
    deleted: bool
    deleted_at: datetime


@dataclass
class TokenSession:
    user_id: str
    client_id: str
    expires_at: datetime


@dataclass
class UserRecord:
    user: User
    password_hash: str


@dataclass
class IdempotencyRecord:
    request_hash: str
    response_body: Any
    status_code: int
    expires_at: datetime


@dataclass
class AssetRecord:
    owner_id: str
    asset: Asset
    upload_id: str
    part_size_bytes: int
    uploaded_parts: list[UploadedPart]
    content: bytes | None = None
    part_contents: dict[int, bytes] = dataclass_field(default_factory=dict)


@dataclass
class ExportRecord:
    owner_id: str
    export_id: str
    asset_id: str
    document_id: str
    document_revision: int
    format: Literal["pdf", "docx"]
    snapshot: Document
    created_at: datetime


@dataclass
class DocumentVersionRecord:
    version: DocumentVersion
    snapshot: Document


@dataclass
class ShareLinkRecord:
    link: ShareLink
    token: str
    document_id: str


@dataclass
class GroupRecord:
    id: str
    name: str
    invite_code: str
    invite_code_expires_at: datetime
    created_by: str
    created_at: datetime
    updated_at: datetime


@dataclass
class GroupDocumentMessageRecord:
    message: GroupDocumentMessage
    document_snapshot: Document


@dataclass
class AuthContext:
    user_id: str
    client_id: str
    user: User
    access_token: str


ManuscriptBlockListAdapter = TypeAdapter(list[ManuscriptBlock])
DocumentBlockListAdapter = TypeAdapter(list[DocumentBlock])
UploadedPartListAdapter = TypeAdapter(list[UploadedPart])
StringListAdapter = TypeAdapter(list[str])


def jsonb(value: Any) -> str:
    return json.dumps(jsonable_encoder(value), ensure_ascii=False, separators=(",", ":"))


def jsonb_part_contents(part_contents: dict[int, bytes]) -> str:
    encoded = {str(part_number): base64.b64encode(content).decode("ascii") for part_number, content in part_contents.items()}
    return json.dumps(encoded, ensure_ascii=False, separators=(",", ":"))


def parse_jsonb(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        return json.loads(value)
    return value


class PostgresRepository:
    def __init__(self, database: DatabaseState) -> None:
        if database.pool is None:
            raise RuntimeError("PostgreSQL is required for API data access.")
        self.pool = database.pool

    async def get_user_record(self, user_id: str) -> UserRecord | None:
        row = await self.pool.fetchrow(
            "SELECT id, email, name, avatar_url, password_hash, created_at FROM users WHERE id = $1",
            user_id,
        )
        return user_record_from_row(row) if row else None

    async def get_user_record_by_email(self, email: str) -> UserRecord | None:
        row = await self.pool.fetchrow(
            "SELECT id, email, name, avatar_url, password_hash, created_at FROM users WHERE email = $1",
            email.lower(),
        )
        return user_record_from_row(row) if row else None

    async def create_user(self, user: User, encoded_password: str) -> None:
        await self.pool.execute(
            """
            INSERT INTO users(id, email, name, avatar_url, password_hash, created_at)
            VALUES($1, $2, $3, $4, $5, $6)
            """,
            user.id,
            str(user.email).lower(),
            user.name,
            user.avatar_url,
            encoded_password,
            user.created_at,
        )

    async def create_tokens(self, user_id: str, client_id: str) -> AuthResponse:
        user_record = await self.get_user_record(user_id)
        if not user_record:
            raise APIError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Access token is missing, expired, or invalid.")
        access_token = make_token("access")
        refresh_token = make_token("refresh")
        now = utcnow()
        await self.pool.executemany(
            """
            INSERT INTO auth_tokens(token, token_type, user_id, client_id, expires_at, created_at)
            VALUES($1, $2, $3, $4, $5, $6)
            """,
            [
                (access_token, "access", user_id, client_id, now + timedelta(seconds=ACCESS_TOKEN_SECONDS), now),
                (refresh_token, "refresh", user_id, client_id, now + timedelta(seconds=REFRESH_TOKEN_SECONDS), now),
            ],
        )
        return AuthResponse(
            access_token=access_token,
            access_token_expires_in=ACCESS_TOKEN_SECONDS,
            refresh_token=refresh_token,
            refresh_token_expires_in=REFRESH_TOKEN_SECONDS,
            user=user_record.user,
        )

    async def get_token_session(self, token: str, token_type: str) -> TokenSession | None:
        row = await self.pool.fetchrow(
            """
            SELECT user_id, client_id, expires_at
            FROM auth_tokens
            WHERE token = $1 AND token_type = $2
            """,
            token,
            token_type,
        )
        return TokenSession(user_id=row["user_id"], client_id=row["client_id"], expires_at=row["expires_at"]) if row else None

    async def delete_token(self, token: str) -> None:
        await self.pool.execute("DELETE FROM auth_tokens WHERE token = $1", token)

    async def delete_tokens_for_client(self, user_id: str, client_id: str) -> None:
        await self.pool.execute("DELETE FROM auth_tokens WHERE user_id = $1 AND client_id = $2", user_id, client_id)

    async def upsert_device(self, user_id: str, device_input: DeviceInput) -> Device:
        now = utcnow()
        row = await self.pool.fetchrow(
            "SELECT created_at FROM devices WHERE user_id = $1 AND client_id = $2",
            user_id,
            device_input.client_id,
        )
        device = Device(
            id=device_input.client_id,
            platform=device_input.platform,
            app_version=device_input.app_version,
            name=device_input.name,
            last_seen_at=now,
            created_at=row["created_at"] if row else now,
        )
        await self.pool.execute(
            """
            INSERT INTO devices(user_id, client_id, platform, app_version, name, last_seen_at, created_at)
            VALUES($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (user_id, client_id) DO UPDATE SET
                platform = EXCLUDED.platform,
                app_version = EXCLUDED.app_version,
                name = EXCLUDED.name,
                last_seen_at = EXCLUDED.last_seen_at
            """,
            user_id,
            device.id,
            device.platform,
            device.app_version,
            device.name,
            device.last_seen_at,
            device.created_at,
        )
        return device

    async def touch_device(self, user_id: str, client_id: str) -> None:
        await self.pool.execute(
            "UPDATE devices SET last_seen_at = $1 WHERE user_id = $2 AND client_id = $3",
            utcnow(),
            user_id,
            client_id,
        )

    async def list_devices(self, user_id: str) -> list[Device]:
        rows = await self.pool.fetch(
            """
            SELECT client_id, platform, app_version, name, last_seen_at, created_at
            FROM devices
            WHERE user_id = $1
            ORDER BY last_seen_at DESC, client_id DESC
            """,
            user_id,
        )
        return [device_from_row(row) for row in rows]

    async def delete_device(self, user_id: str, client_id: str) -> bool:
        result = await self.pool.execute("DELETE FROM devices WHERE user_id = $1 AND client_id = $2", user_id, client_id)
        await self.delete_tokens_for_client(user_id, client_id)
        return result.endswith("1")

    async def get_idempotency(self, scope: tuple[str, str, str, str]) -> IdempotencyRecord | None:
        row = await self.pool.fetchrow(
            """
            SELECT request_hash, response_body, status_code, expires_at
            FROM idempotency_records
            WHERE user_id = $1 AND method = $2 AND path = $3 AND idempotency_key = $4
            """,
            *scope,
        )
        if not row:
            return None
        return IdempotencyRecord(
            request_hash=row["request_hash"],
            response_body=parse_jsonb(row["response_body"]),
            status_code=row["status_code"],
            expires_at=row["expires_at"],
        )

    async def save_idempotency(self, scope: tuple[str, str, str, str], record: IdempotencyRecord) -> None:
        await self.pool.execute(
            """
            INSERT INTO idempotency_records(user_id, method, path, idempotency_key, request_hash, response_body, status_code, expires_at)
            VALUES($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
            ON CONFLICT (user_id, method, path, idempotency_key) DO UPDATE SET
                request_hash = EXCLUDED.request_hash,
                response_body = EXCLUDED.response_body,
                status_code = EXCLUDED.status_code,
                expires_at = EXCLUDED.expires_at,
                created_at = now()
            """,
            *scope,
            record.request_hash,
            jsonb(record.response_body),
            record.status_code,
            record.expires_at,
        )

    async def save_asset(self, record: AssetRecord) -> None:
        asset = record.asset
        await self.pool.execute(
            """
            INSERT INTO assets(
                id, owner_id, kind, filename, content_type, size_bytes, checksum_sha256,
                duration_ms, width, height, status, upload_id, part_size_bytes,
                uploaded_parts, content, part_contents, created_at, updated_at
            )
            VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16::jsonb, $17, $18)
            ON CONFLICT (id) DO UPDATE SET
                kind = EXCLUDED.kind,
                filename = EXCLUDED.filename,
                content_type = EXCLUDED.content_type,
                size_bytes = EXCLUDED.size_bytes,
                checksum_sha256 = EXCLUDED.checksum_sha256,
                duration_ms = EXCLUDED.duration_ms,
                width = EXCLUDED.width,
                height = EXCLUDED.height,
                status = EXCLUDED.status,
                upload_id = EXCLUDED.upload_id,
                part_size_bytes = EXCLUDED.part_size_bytes,
                uploaded_parts = EXCLUDED.uploaded_parts,
                content = EXCLUDED.content,
                part_contents = EXCLUDED.part_contents,
                updated_at = EXCLUDED.updated_at
            """,
            asset.id,
            record.owner_id,
            asset.kind,
            asset.filename,
            asset.content_type,
            asset.size_bytes,
            asset.checksum_sha256,
            asset.duration_ms,
            asset.width,
            asset.height,
            asset.status,
            record.upload_id,
            record.part_size_bytes,
            jsonb(record.uploaded_parts),
            record.content,
            jsonb_part_contents(record.part_contents),
            asset.created_at,
            asset.updated_at,
        )

    async def get_asset_record(self, asset_id: str) -> AssetRecord | None:
        row = await self.pool.fetchrow("SELECT * FROM assets WHERE id = $1", asset_id)
        return asset_record_from_row(row) if row else None

    async def delete_asset(self, asset_id: str) -> None:
        await self.pool.execute("DELETE FROM assets WHERE id = $1", asset_id)

    async def asset_is_referenced(self, owner_id: str, asset_id: str) -> bool:
        manuscripts = await self.list_manuscripts(owner_id, include_deleted=True)
        for manuscript in manuscripts:
            for block in manuscript.blocks:
                if isinstance(block, (ManuscriptAudioBlock, ManuscriptImageBlock)) and block.props.asset_id == asset_id:
                    return True
                if isinstance(block, ManuscriptHandwritingBlock) and block.props.image_asset_id == asset_id:
                    return True
        documents = await self.list_documents(owner_id)
        for document in documents:
            for block in document.blocks:
                if isinstance(block, DocumentImageBlock) and block.props.asset_id == asset_id:
                    return True
        return False

    async def list_manuscripts(self, owner_id: str, include_deleted: bool = False) -> list[Manuscript]:
        rows = await self.pool.fetch(
            """
            SELECT * FROM manuscripts
            WHERE owner_id = $1 AND ($2::boolean OR NOT deleted)
            ORDER BY updated_at DESC, id DESC
            """,
            owner_id,
            include_deleted,
        )
        return [manuscript_from_row(row) for row in rows]

    async def get_manuscript(self, manuscript_id: str) -> Manuscript | None:
        row = await self.pool.fetchrow("SELECT * FROM manuscripts WHERE id = $1", manuscript_id)
        return manuscript_from_row(row) if row else None

    async def save_manuscript(self, manuscript: Manuscript) -> None:
        await self.pool.execute(
            """
            INSERT INTO manuscripts(id, owner_id, title, revision, blocks, deleted, deleted_at, created_at, updated_at)
            VALUES($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
            ON CONFLICT (id) DO UPDATE SET
                title = EXCLUDED.title,
                revision = EXCLUDED.revision,
                blocks = EXCLUDED.blocks,
                deleted = EXCLUDED.deleted,
                deleted_at = EXCLUDED.deleted_at,
                updated_at = EXCLUDED.updated_at
            """,
            manuscript.id,
            manuscript.owner_id,
            manuscript.title,
            manuscript.revision,
            jsonb(manuscript.blocks),
            manuscript.deleted,
            manuscript.deleted_at,
            manuscript.created_at,
            manuscript.updated_at,
        )

    async def list_documents(self, owner_id: str) -> list[Document]:
        rows = await self.pool.fetch(
            "SELECT * FROM documents WHERE owner_id = $1 ORDER BY updated_at DESC, id DESC",
            owner_id,
        )
        return [document_from_row(row) for row in rows]

    async def get_document(self, document_id: str) -> Document | None:
        row = await self.pool.fetchrow("SELECT * FROM documents WHERE id = $1", document_id)
        return document_from_row(row) if row else None

    async def save_document(self, document: Document) -> None:
        await self.pool.execute(
            """
            INSERT INTO documents(
                id, owner_id, title, source_manuscript_ids, derived_from,
                revision, blocks, permission, created_at, updated_at
            )
            VALUES($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8, $9, $10)
            ON CONFLICT (id) DO UPDATE SET
                title = EXCLUDED.title,
                source_manuscript_ids = EXCLUDED.source_manuscript_ids,
                derived_from = EXCLUDED.derived_from,
                revision = EXCLUDED.revision,
                blocks = EXCLUDED.blocks,
                permission = EXCLUDED.permission,
                updated_at = EXCLUDED.updated_at
            """,
            document.id,
            document.owner_id,
            document.title,
            jsonb(document.source_manuscript_ids),
            jsonb(document.derived_from) if document.derived_from else None,
            document.revision,
            jsonb(document.blocks),
            document.permission,
            document.created_at,
            document.updated_at,
        )

    async def delete_document(self, document_id: str) -> None:
        await self.pool.execute("DELETE FROM documents WHERE id = $1", document_id)

    async def create_group(self, group: GroupRecord) -> bool:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    """
                    INSERT INTO groups(id, name, invite_code, invite_code_expires_at, created_by, created_at, updated_at)
                    VALUES($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (invite_code) DO NOTHING
                    RETURNING id
                    """,
                    group.id,
                    group.name,
                    group.invite_code,
                    group.invite_code_expires_at,
                    group.created_by,
                    group.created_at,
                    group.updated_at,
                )
                if not row:
                    return False
                await connection.execute(
                    """
                    INSERT INTO group_members(group_id, user_id, role, joined_at)
                    VALUES($1, $2, $3, $4)
                    """,
                    group.id,
                    group.created_by,
                    "owner",
                    group.created_at,
                )
        return True

    async def get_group_record(self, group_id: str) -> GroupRecord | None:
        row = await self.pool.fetchrow("SELECT * FROM groups WHERE id = $1", group_id)
        return group_record_from_row(row) if row else None

    async def get_group_record_by_invite_code(self, invite_code: str) -> GroupRecord | None:
        row = await self.pool.fetchrow("SELECT * FROM groups WHERE invite_code = $1", invite_code)
        return group_record_from_row(row) if row else None

    async def get_group_member_role(self, group_id: str, user_id: str) -> GroupRole | None:
        row = await self.pool.fetchrow(
            "SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2",
            group_id,
            user_id,
        )
        return row["role"] if row else None

    async def add_group_member(self, group_id: str, user_id: str, role: GroupRole, joined_at: datetime) -> bool:
        result = await self.pool.execute(
            """
            INSERT INTO group_members(group_id, user_id, role, joined_at)
            VALUES($1, $2, $3, $4)
            ON CONFLICT (group_id, user_id) DO NOTHING
            """,
            group_id,
            user_id,
            role,
            joined_at,
        )
        inserted = result.endswith("1")
        if inserted:
            await self.pool.execute("UPDATE groups SET updated_at = $1 WHERE id = $2", joined_at, group_id)
        return inserted

    async def list_groups_for_user(self, user_id: str) -> list[GroupSummary]:
        rows = await self.pool.fetch(
            """
            SELECT
                g.id,
                g.name,
                g.invite_code,
                g.invite_code_expires_at,
                g.created_at,
                g.updated_at,
                gm.role,
                (SELECT COUNT(*) FROM group_members members WHERE members.group_id = g.id)::int AS member_count
            FROM groups g
            JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1
            ORDER BY g.updated_at DESC, g.id DESC
            """,
            user_id,
        )
        return [group_summary_from_row(row) for row in rows]

    async def get_group_summary_for_user(self, group_id: str, user_id: str) -> GroupSummary | None:
        row = await self.pool.fetchrow(
            """
            SELECT
                g.id,
                g.name,
                g.invite_code,
                g.invite_code_expires_at,
                g.created_at,
                g.updated_at,
                gm.role,
                (SELECT COUNT(*) FROM group_members members WHERE members.group_id = g.id)::int AS member_count
            FROM groups g
            JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $2
            WHERE g.id = $1
            """,
            group_id,
            user_id,
        )
        return group_summary_from_row(row) if row else None

    async def save_group_document_message(self, record: GroupDocumentMessageRecord) -> None:
        message = record.message
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    INSERT INTO group_document_messages(
                        id, group_id, sender_id, document_id, document_title, document_revision, document_snapshot, sent_at
                    )
                    VALUES($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
                    """,
                    message.id,
                    message.group_id,
                    message.sender_id,
                    message.document_id,
                    message.document_title,
                    message.document_revision,
                    jsonb(record.document_snapshot),
                    message.sent_at,
                )
                await connection.execute("UPDATE groups SET updated_at = $1 WHERE id = $2", message.sent_at, message.group_id)

    async def list_group_document_messages(self, group_id: str) -> list[GroupDocumentMessage]:
        rows = await self.pool.fetch(
            """
            SELECT
                messages.id,
                messages.group_id,
                messages.sender_id,
                users.name AS sender_name,
                messages.document_id,
                messages.document_title,
                messages.document_revision,
                messages.sent_at
            FROM group_document_messages messages
            JOIN users ON users.id = messages.sender_id
            WHERE messages.group_id = $1
            ORDER BY messages.sent_at DESC, messages.id DESC
            """,
            group_id,
        )
        return [group_document_message_from_row(row) for row in rows]

    async def get_group_document_message_record(self, group_id: str, message_id: str) -> GroupDocumentMessageRecord | None:
        row = await self.pool.fetchrow(
            """
            SELECT
                messages.id,
                messages.group_id,
                messages.sender_id,
                users.name AS sender_name,
                messages.document_id,
                messages.document_title,
                messages.document_revision,
                messages.document_snapshot,
                messages.sent_at
            FROM group_document_messages messages
            JOIN users ON users.id = messages.sender_id
            WHERE messages.group_id = $1 AND messages.id = $2
            """,
            group_id,
            message_id,
        )
        return group_document_message_record_from_row(row) if row else None

    async def create_document_version(self, document: Document, title: str) -> None:
        version = DocumentVersion(
            id=new_id("ver"),
            document_id=document.id,
            revision=document.revision,
            title=title,
            created_by=document.owner_id,
            created_at=utcnow(),
        )
        await self.pool.execute(
            """
            INSERT INTO document_versions(id, document_id, revision, title, created_by, snapshot, created_at)
            VALUES($1, $2, $3, $4, $5, $6::jsonb, $7)
            """,
            version.id,
            version.document_id,
            version.revision,
            version.title,
            version.created_by,
            jsonb(document),
            version.created_at,
        )

    async def list_document_versions(self, document_id: str) -> list[DocumentVersion]:
        rows = await self.pool.fetch(
            """
            SELECT id, document_id, revision, title, created_by, created_at
            FROM document_versions
            WHERE document_id = $1
            ORDER BY created_at DESC, id DESC
            """,
            document_id,
        )
        return [document_version_from_row(row) for row in rows]

    async def find_document_version(self, document_id: str, version_id: str) -> DocumentVersionRecord | None:
        row = await self.pool.fetchrow(
            "SELECT * FROM document_versions WHERE document_id = $1 AND id = $2",
            document_id,
            version_id,
        )
        return document_version_record_from_row(row) if row else None

    async def save_task(self, owner_id: str, task: Task, task_input: dict[str, Any] | None = None) -> None:
        await self.pool.execute(
            """
            INSERT INTO tasks(id, owner_id, type, status, input, progress, result, error, retry_count, billing, created_at, updated_at)
            VALUES($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11, $12)
            ON CONFLICT (id) DO UPDATE SET
                status = EXCLUDED.status,
                input = COALESCE(EXCLUDED.input, tasks.input),
                progress = EXCLUDED.progress,
                result = EXCLUDED.result,
                error = EXCLUDED.error,
                retry_count = EXCLUDED.retry_count,
                billing = EXCLUDED.billing,
                updated_at = EXCLUDED.updated_at
            """,
            task.id,
            owner_id,
            task.type,
            task.status,
            jsonb(task_input) if task_input is not None else None,
            jsonb(task.progress),
            jsonb(task.result) if task.result is not None else None,
            jsonb(task.error) if task.error is not None else None,
            task.retry_count,
            jsonb(task.billing) if task.billing is not None else None,
            task.created_at,
            task.updated_at,
        )

    async def get_task_record(self, task_id: str) -> tuple[str, Task] | None:
        row = await self.pool.fetchrow("SELECT * FROM tasks WHERE id = $1", task_id)
        return task_record_from_row(row) if row else None

    async def save_export(self, record: ExportRecord) -> None:
        await self.pool.execute(
            """
            INSERT INTO exports(id, owner_id, asset_id, document_id, document_revision, format, snapshot, created_at)
            VALUES($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
            ON CONFLICT (id) DO UPDATE SET
                asset_id = EXCLUDED.asset_id,
                document_id = EXCLUDED.document_id,
                document_revision = EXCLUDED.document_revision,
                format = EXCLUDED.format,
                snapshot = EXCLUDED.snapshot
            """,
            record.export_id,
            record.owner_id,
            record.asset_id,
            record.document_id,
            record.document_revision,
            record.format,
            jsonb(record.snapshot),
            record.created_at,
        )

    async def get_export_record(self, export_id: str) -> ExportRecord | None:
        row = await self.pool.fetchrow("SELECT * FROM exports WHERE id = $1", export_id)
        return export_record_from_row(row) if row else None

    async def save_share_link(self, record: ShareLinkRecord) -> None:
        await self.pool.execute(
            """
            INSERT INTO share_links(id, document_id, permission, url, token, expires_at, created_at)
            VALUES($1, $2, $3, $4, $5, $6, $7)
            """,
            record.link.id,
            record.document_id,
            record.link.permission,
            record.link.url,
            record.token,
            record.link.expires_at,
            record.link.created_at,
        )

    async def get_share_link_record(self, share_id: str) -> ShareLinkRecord | None:
        row = await self.pool.fetchrow("SELECT * FROM share_links WHERE id = $1", share_id)
        return share_link_record_from_row(row) if row else None


def user_record_from_row(row: Any) -> UserRecord:
    user = User(id=row["id"], email=row["email"], name=row["name"], avatar_url=row["avatar_url"], created_at=row["created_at"])
    return UserRecord(user=user, password_hash=row["password_hash"])


def device_from_row(row: Any) -> Device:
    return Device(
        id=row["client_id"],
        platform=row["platform"],
        app_version=row["app_version"],
        name=row["name"],
        last_seen_at=row["last_seen_at"],
        created_at=row["created_at"],
    )


def asset_record_from_row(row: Any) -> AssetRecord:
    asset = Asset(
        id=row["id"],
        kind=row["kind"],
        filename=row["filename"],
        content_type=row["content_type"],
        size_bytes=row["size_bytes"],
        checksum_sha256=row["checksum_sha256"],
        duration_ms=row["duration_ms"],
        width=row["width"],
        height=row["height"],
        status=row["status"],
        url=None,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
    return AssetRecord(
        owner_id=row["owner_id"],
        asset=asset,
        upload_id=row["upload_id"],
        part_size_bytes=row["part_size_bytes"],
        uploaded_parts=UploadedPartListAdapter.validate_python(parse_jsonb(row["uploaded_parts"])),
        content=row["content"],
        part_contents={int(part_number): base64.b64decode(content) for part_number, content in (parse_jsonb(row["part_contents"]) or {}).items()},
    )


def manuscript_from_row(row: Any) -> Manuscript:
    return Manuscript(
        id=row["id"],
        title=row["title"],
        owner_id=row["owner_id"],
        revision=row["revision"],
        blocks=ManuscriptBlockListAdapter.validate_python(parse_jsonb(row["blocks"])),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        deleted=row["deleted"],
        deleted_at=row["deleted_at"],
    )


def document_from_row(row: Any) -> Document:
    derived_from = parse_jsonb(row["derived_from"])
    return Document(
        id=row["id"],
        title=row["title"],
        owner_id=row["owner_id"],
        source_manuscript_ids=StringListAdapter.validate_python(parse_jsonb(row["source_manuscript_ids"])),
        derived_from=DerivedFrom.model_validate(derived_from) if derived_from else None,
        revision=row["revision"],
        blocks=DocumentBlockListAdapter.validate_python(parse_jsonb(row["blocks"])),
        permission=row["permission"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def group_record_from_row(row: Any) -> GroupRecord:
    return GroupRecord(
        id=row["id"],
        name=row["name"],
        invite_code=row["invite_code"],
        invite_code_expires_at=row["invite_code_expires_at"],
        created_by=row["created_by"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def group_summary_from_row(row: Any) -> GroupSummary:
    return GroupSummary(
        id=row["id"],
        name=row["name"],
        invite_code=row["invite_code"],
        invite_code_expires_at=row["invite_code_expires_at"],
        member_count=row["member_count"],
        role=row["role"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def group_document_message_from_row(row: Any) -> GroupDocumentMessage:
    return GroupDocumentMessage(
        id=row["id"],
        group_id=row["group_id"],
        sender_id=row["sender_id"],
        sender_name=row["sender_name"],
        document_id=row["document_id"],
        document_title=row["document_title"],
        document_revision=row["document_revision"],
        sent_at=row["sent_at"],
    )


def group_document_message_record_from_row(row: Any) -> GroupDocumentMessageRecord:
    return GroupDocumentMessageRecord(
        message=group_document_message_from_row(row),
        document_snapshot=Document.model_validate(parse_jsonb(row["document_snapshot"])),
    )


def document_version_from_row(row: Any) -> DocumentVersion:
    return DocumentVersion(
        id=row["id"],
        document_id=row["document_id"],
        revision=row["revision"],
        title=row["title"],
        created_by=row["created_by"],
        created_at=row["created_at"],
    )


def document_version_record_from_row(row: Any) -> DocumentVersionRecord:
    return DocumentVersionRecord(
        version=document_version_from_row(row),
        snapshot=Document.model_validate(parse_jsonb(row["snapshot"])),
    )


def task_record_from_row(row: Any) -> tuple[str, Task]:
    error = parse_jsonb(row["error"])
    task = Task(
        id=row["id"],
        type=row["type"],
        status=row["status"],
        progress=TaskProgress.model_validate(parse_jsonb(row["progress"])),
        result=parse_jsonb(row["result"]),
        error=TaskError.model_validate(error) if error else None,
        retry_count=row["retry_count"],
        billing=parse_jsonb(row["billing"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
    return row["owner_id"], task


def export_record_from_row(row: Any) -> ExportRecord:
    return ExportRecord(
        owner_id=row["owner_id"],
        export_id=row["id"],
        asset_id=row["asset_id"],
        document_id=row["document_id"],
        document_revision=row["document_revision"],
        format=row["format"],
        snapshot=Document.model_validate(parse_jsonb(row["snapshot"])),
        created_at=row["created_at"],
    )


def share_link_record_from_row(row: Any) -> ShareLinkRecord:
    link = ShareLink(
        id=row["id"],
        document_id=row["document_id"],
        permission=row["permission"],
        url=row["url"],
        expires_at=row["expires_at"],
        created_at=row["created_at"],
    )
    return ShareLinkRecord(link=link, token=row["token"], document_id=row["document_id"])


bearer_scheme = HTTPBearer(auto_error=False)


def get_repository(connection: HTTPConnection) -> PostgresRepository:
    repository = getattr(connection.app.state, "repository", None)
    if repository is None:
        raise APIError(status.HTTP_500_INTERNAL_SERVER_ERROR, "internal_error", "PostgreSQL repository is not initialized.")
    return repository


async def auth_context(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)] = None,
    db: PostgresRepository = Depends(get_repository),
) -> AuthContext:
    if not credentials or credentials.scheme.lower() != "bearer":
        raise APIError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Authorization bearer token is required.")
    token = credentials.credentials.strip()
    session = await db.get_token_session(token, "access")
    if not session or session.expires_at <= utcnow():
        raise APIError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Access token is missing, expired, or invalid.")
    user_record = await db.get_user_record(session.user_id)
    if not user_record:
        raise APIError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Access token is missing, expired, or invalid.")
    await db.touch_device(session.user_id, session.client_id)
    return AuthContext(user_id=session.user_id, client_id=session.client_id, user=user_record.user, access_token=token)


async def client_id_header_doc(x_client_id: Annotated[str, Header(alias="X-Client-Id")]) -> str:
    return x_client_id


async def idempotency_key_header_doc(idempotency_key: Annotated[str, Header(alias="Idempotency-Key")]) -> str:
    return idempotency_key


CLIENT_HEADER_DEPENDENCIES = [Depends(client_id_header_doc)]
IDEMPOTENT_WRITE_DEPENDENCIES = [Depends(client_id_header_doc), Depends(idempotency_key_header_doc)]


ERROR_RESPONSES = {
    400: {"model": ErrorResponse, "description": "Invalid request."},
    401: {"model": ErrorResponse, "description": "Unauthorized."},
    403: {"model": ErrorResponse, "description": "Forbidden."},
    404: {"model": ErrorResponse, "description": "Not found."},
    409: {"model": ErrorResponse, "description": "Conflict."},
    413: {"model": ErrorResponse, "description": "Payload too large."},
    422: {"model": ErrorResponse, "description": "Validation error."},
    429: {"model": ErrorResponse, "description": "Rate limited."},
    500: {"model": ErrorResponse, "description": "Internal error."},
    503: {"model": ErrorResponse, "description": "AI service unavailable."},
}


def require_client_header(request: Request, ctx: AuthContext, body_client_id: str | None = None) -> str:
    client_id = request.headers.get("X-Client-Id")
    if not client_id:
        raise validation_error("X-Client-Id header is required for authenticated write requests.")
    if body_client_id and body_client_id != client_id:
        raise validation_error("Request body client_id must match X-Client-Id.")
    if client_id != ctx.client_id:
        raise APIError(status.HTTP_403_FORBIDDEN, "forbidden", "X-Client-Id does not match the access token device.")
    return client_id


def require_idempotency_header(request: Request) -> str:
    key = request.headers.get("Idempotency-Key")
    if not key:
        raise validation_error("Idempotency-Key header is required for this write request.")
    return key


async def require_idempotency(request: Request, ctx: AuthContext, db: PostgresRepository) -> tuple[tuple[str, str, str, str], str, IdempotencyRecord | None]:
    key = request.headers.get("Idempotency-Key")
    if not key:
        raise validation_error("Idempotency-Key header is required for this write request.")
    body = await request.body()
    request_hash = hash_request_body(body)
    scope = (ctx.user_id, request.method.upper(), request.url.path, key)
    existing = await db.get_idempotency(scope)
    if existing and existing.expires_at > utcnow():
        if existing.request_hash != request_hash:
            raise APIError(
                status.HTTP_409_CONFLICT,
                "idempotency_conflict",
                "Idempotency-Key was reused with a different request body.",
            )
        return scope, request_hash, existing
    return scope, request_hash, None


async def idempotent_json_response(db: PostgresRepository, idem: tuple[tuple[str, str, str, str], str, IdempotencyRecord | None], body: Any, status_code: int) -> JSONResponse:
    scope, request_hash, existing = idem
    if existing:
        return ContractJSONResponse(content=jsonable_encoder(existing.response_body), status_code=existing.status_code)
    record = IdempotencyRecord(
        request_hash=request_hash,
        response_body=jsonable_encoder(body),
        status_code=status_code,
        expires_at=utcnow() + timedelta(seconds=IDEMPOTENCY_SECONDS),
    )
    await db.save_idempotency(scope, record)
    return ContractJSONResponse(content=jsonable_encoder(body), status_code=status_code)


def make_error_response(request: Request, status_code: int, code: str, message: str, details: dict[str, Any] | None = None) -> JSONResponse:
    request_id = getattr(request.state, "request_id", new_id("req"))
    body = ErrorResponse(error=ErrorBody(code=code, message=message, details=details, request_id=request_id))
    return ContractJSONResponse(status_code=status_code, content=jsonable_encoder(body))


def assert_owner(user_id: str, owner_id: str) -> None:
    if user_id != owner_id:
        raise APIError(status.HTTP_403_FORBIDDEN, "forbidden", "You do not have access to this resource.")


async def get_asset_record(db: PostgresRepository, asset_id: str, user_id: str) -> AssetRecord:
    record = await db.get_asset_record(asset_id)
    if not record:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Asset not found.")
    assert_owner(user_id, record.owner_id)
    return record


async def get_manuscript(db: PostgresRepository, manuscript_id: str, user_id: str) -> Manuscript:
    manuscript = await db.get_manuscript(manuscript_id)
    if not manuscript or manuscript.deleted:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Manuscript not found.")
    assert_owner(user_id, manuscript.owner_id)
    return manuscript


async def get_document(db: PostgresRepository, document_id: str, user_id: str) -> Document:
    document = await db.get_document(document_id)
    if not document:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Document not found.")
    assert_owner(user_id, document.owner_id)
    return document


async def get_group_record(db: PostgresRepository, group_id: str) -> GroupRecord:
    group = await db.get_group_record(group_id)
    if not group:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Group not found.")
    return group


async def require_group_member(db: PostgresRepository, group_id: str, user_id: str) -> GroupRole:
    await get_group_record(db, group_id)
    role = await db.get_group_member_role(group_id, user_id)
    if not role:
        raise APIError(status.HTTP_403_FORBIDDEN, "forbidden", "You are not a member of this group.")
    return role


async def get_task(db: PostgresRepository, task_id: str, user_id: str) -> Task:
    record = await db.get_task_record(task_id)
    if not record:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Task not found.")
    owner_id, task = record
    assert_owner(user_id, owner_id)
    return task


async def get_export_record(db: PostgresRepository, export_id: str, user_id: str) -> ExportRecord:
    record = await db.get_export_record(export_id)
    if not record:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Export not found.")
    assert_owner(user_id, record.owner_id)
    return record


def validate_block_author_and_client(block: BaseBlock, ctx: AuthContext, client_id: str) -> None:
    if block.author_id != ctx.user_id:
        raise validation_error("Block author_id must match the authenticated user.")
    if block.client_id != client_id:
        raise validation_error("Block client_id must match X-Client-Id.")
    ensure_client_time(block.created_at, "block.created_at")


def validate_block_payload(block: BaseBlock) -> None:
    payload = json.dumps(block.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_BLOCK_BYTES:
        raise APIError(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "payload_too_large", "Block JSON exceeds 256KB.")
    if isinstance(block, ManuscriptHandwritingBlock):
        total_points = sum(len(stroke.points) for stroke in block.props.strokes)
        if total_points > MAX_HANDWRITING_POINTS:
            raise APIError(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "payload_too_large", "Handwriting block exceeds 5000 points.")


async def ensure_asset_ready(db: PostgresRepository, asset_id: str | None, owner_id: str) -> None:
    if not asset_id:
        return
    record = await get_asset_record(db, asset_id, owner_id)
    if record.asset.status != "ready":
        raise validation_error("Block can only reference ready assets.", {"asset_id": asset_id, "status": record.asset.status})


async def validate_block_asset_refs(db: PostgresRepository, block: BaseBlock, owner_id: str) -> None:
    if isinstance(block, ManuscriptAudioBlock):
        await ensure_asset_ready(db, block.props.asset_id, owner_id)
    elif isinstance(block, ManuscriptImageBlock):
        await ensure_asset_ready(db, block.props.asset_id, owner_id)
    elif isinstance(block, ManuscriptHandwritingBlock):
        await ensure_asset_ready(db, block.props.image_asset_id, owner_id)
    elif isinstance(block, DocumentImageBlock):
        await ensure_asset_ready(db, block.props.asset_id, owner_id)


def block_index(blocks: list[BaseBlock], block_id: str) -> int | None:
    for index, block in enumerate(blocks):
        if block.id == block_id:
            return index
    return None


def insert_or_move_block(blocks: list[Any], block: Any, before_block_id: str | None, after_block_id: str | None) -> None:
    existing_index = block_index(blocks, block.id)
    if existing_index is not None:
        blocks.pop(existing_index)
    if before_block_id:
        index = block_index(blocks, before_block_id)
        if index is None:
            raise validation_error("before_block_id does not exist.")
        blocks.insert(index, block)
    elif after_block_id:
        index = block_index(blocks, after_block_id)
        if index is None:
            raise validation_error("after_block_id does not exist.")
        blocks.insert(index + 1, block)
    else:
        blocks.append(block)


async def apply_manuscript_operations(
    db: PostgresRepository,
    manuscript: Manuscript,
    payload: ManuscriptSyncRequest,
    ctx: AuthContext,
    client_id: str,
) -> tuple[list[ManuscriptBlock], list[str]]:
    now = utcnow()
    blocks = copy.deepcopy(manuscript.blocks)
    changed: list[ManuscriptBlock] = []
    applied: list[str] = []
    for op in payload.operations:
        ensure_client_time(op.created_at, "operation.created_at")
        if op.type == "upsert_block" and op.block is not None:
            validate_block_author_and_client(op.block, ctx, client_id)
            validate_block_payload(op.block)
            await validate_block_asset_refs(db, op.block, ctx.user_id)
            existing_index = block_index(blocks, op.block.id)
            existing_revision = blocks[existing_index].revision if existing_index is not None else op.block.revision
            block = op.block.model_copy(update={"updated_at": now, "revision": max(existing_revision + 1, op.block.revision)})
            insert_or_move_block(blocks, block, op.before_block_id, op.after_block_id)
            changed.append(block)
        elif op.type in {"delete_block", "restore_block"} and op.block_id:
            index = block_index(blocks, op.block_id)
            if index is None:
                raise validation_error("block_id does not exist.")
            deleted = op.type == "delete_block"
            block = blocks[index].model_copy(update={"deleted": deleted, "updated_at": now, "revision": blocks[index].revision + 1})
            blocks[index] = block
            changed.append(block)
        elif op.type == "move_block" and op.block_id:
            index = block_index(blocks, op.block_id)
            if index is None:
                raise validation_error("block_id does not exist.")
            block = blocks[index].model_copy(update={"updated_at": now, "revision": blocks[index].revision + 1})
            insert_or_move_block(blocks, block, op.before_block_id, op.after_block_id)
            changed.append(block)
        applied.append(op.op_id)
    manuscript.blocks = blocks
    manuscript.revision += 1
    manuscript.updated_at = now
    return changed, applied


async def apply_document_operations(
    db: PostgresRepository,
    document: Document,
    payload: DocumentSyncRequest,
    ctx: AuthContext,
    client_id: str,
) -> tuple[list[DocumentBlock], list[str]]:
    now = utcnow()
    blocks = copy.deepcopy(document.blocks)
    changed: list[DocumentBlock] = []
    applied: list[str] = []
    for op in payload.operations:
        ensure_client_time(op.created_at, "operation.created_at")
        if op.type == "upsert_block" and op.block is not None:
            validate_block_author_and_client(op.block, ctx, client_id)
            validate_block_payload(op.block)
            await validate_block_asset_refs(db, op.block, ctx.user_id)
            existing_index = block_index(blocks, op.block.id)
            existing = blocks[existing_index] if existing_index is not None else None
            source_refs = existing.source_refs if existing else []
            existing_revision = existing.revision if existing else op.block.revision
            block = op.block.model_copy(
                update={
                    "source_refs": source_refs,
                    "updated_at": now,
                    "revision": max(existing_revision + 1, op.block.revision),
                }
            )
            insert_or_move_block(blocks, block, op.before_block_id, op.after_block_id)
            changed.append(block)
        elif op.type in {"delete_block", "restore_block"} and op.block_id:
            index = block_index(blocks, op.block_id)
            if index is None:
                raise validation_error("block_id does not exist.")
            deleted = op.type == "delete_block"
            block = blocks[index].model_copy(update={"deleted": deleted, "updated_at": now, "revision": blocks[index].revision + 1})
            blocks[index] = block
            changed.append(block)
        elif op.type == "move_block" and op.block_id:
            index = block_index(blocks, op.block_id)
            if index is None:
                raise validation_error("block_id does not exist.")
            block = blocks[index].model_copy(update={"updated_at": now, "revision": blocks[index].revision + 1})
            insert_or_move_block(blocks, block, op.before_block_id, op.after_block_id)
            changed.append(block)
        applied.append(op.op_id)
    document.blocks = blocks
    document.revision += 1
    document.updated_at = now
    return changed, applied


def make_presigned_parts(request: Request, asset_id: str, upload_id: str, content_type: str, part_size_bytes: int, size_bytes: int) -> list[UploadPart]:
    part_count = max(1, math.ceil(size_bytes / part_size_bytes))
    expires_at = utcnow() + timedelta(minutes=15)
    parts: list[UploadPart] = []
    for part_number in range(1, part_count + 1):
        parts.append(
            UploadPart(
                part_number=part_number,
                upload_url=make_api_upload_url(request, asset_id, upload_id, part_number, expires_at),
                headers={"Content-Type": content_type},
                expires_at=expires_at,
            )
        )
    return parts


def validate_complete_parts(request: AssetCompleteRequest) -> None:
    if not request.parts:
        raise validation_error("parts must not be empty.")
    expected_number = 1
    total_size = 0
    for part in sorted(request.parts, key=lambda item: item.part_number):
        if part.part_number != expected_number:
            raise validation_error("parts must be consecutive from 1.")
        if not part.etag:
            raise validation_error("part etag must not be empty.")
        total_size += part.size_bytes
        expected_number += 1
    if total_size != request.size_bytes:
        raise validation_error("sum(parts.size_bytes) must equal size_bytes.")


def collect_part_contents(record: AssetRecord, parts: list[UploadedPart] | None = None) -> bytes | None:
    selected_parts = sorted(parts if parts is not None else record.uploaded_parts, key=lambda item: item.part_number)
    if not selected_parts:
        return None
    contents: list[bytes] = []
    for part in selected_parts:
        content = record.part_contents.get(part.part_number)
        if content is None or len(content) != part.size_bytes or hashlib.sha256(content).hexdigest() != part.etag:
            return None
        contents.append(content)
    return b"".join(contents)


def asset_content_bytes(record: AssetRecord) -> bytes | None:
    if record.content is not None:
        return record.content
    return collect_part_contents(record)


def require_asset_content(record: AssetRecord) -> bytes:
    content = asset_content_bytes(record)
    if content is None:
        raise validation_error("Asset content is not available in database storage.")
    return content


def header_filename_fallback(filename: str, default: str) -> str:
    fallback = "".join(char if 32 <= ord(char) < 127 and char not in {'\\', '/', '"'} else "_" for char in filename).strip()
    return fallback or default


def content_disposition_filename(filename: str) -> str:
    fallback = header_filename_fallback(filename, "asset")
    return f"inline; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"


def attachment_disposition_filename(filename: str) -> str:
    fallback = header_filename_fallback(filename, "document")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"


def document_summary(document: Document) -> DocumentSummary:
    return DocumentSummary(
        id=document.id,
        title=document.title,
        owner_id=document.owner_id,
        source_manuscript_ids=document.source_manuscript_ids,
        derived_from=document.derived_from,
        revision=document.revision,
        permission=document.permission,
        created_at=document.created_at,
        updated_at=document.updated_at,
    )


def manuscript_summary(manuscript: Manuscript) -> ManuscriptSummary:
    return ManuscriptSummary(
        id=manuscript.id,
        title=manuscript.title,
        owner_id=manuscript.owner_id,
        revision=manuscript.revision,
        created_at=manuscript.created_at,
        updated_at=manuscript.updated_at,
    )


async def device_platform(db: PostgresRepository, user_id: str, client_id: str) -> Platform:
    devices = await db.list_devices(user_id)
    for device in devices:
        if device.id == client_id:
            return device.platform
    return "web"


def source_ref(manuscript_id: str, block_id: str, time_range: SourceRange | None = None, region: SourceRegion | None = None) -> list[SourceRef]:
    return [SourceRef(manuscript_id=manuscript_id, block_id=block_id, range=time_range, region=region)]


def convert_warning(block_id: str, code: str, message: str) -> dict[str, str]:
    return {"block_id": block_id, "code": code, "message": message}


def strip_speech_prefix(text: str) -> str:
    return re.sub(r"^(?:发言[:：]\s*)+", "", text.strip())


def speech_paragraph_text(text: str) -> str:
    content = strip_speech_prefix(text)
    return f"发言：{content}" if content else ""


def fallback_optimize_audio_transcript(text: str) -> str:
    content = local_clean_transcript(text)
    content = re.sub(r"([，,。！？!?])\1+", r"\1", content)
    return content


async def optimize_audio_transcript(text: str, optimize_audio: bool, text_provider: TextProvider) -> str:
    content = strip_speech_prefix(text)
    if not optimize_audio:
        return content
    try:
        optimized = strip_speech_prefix(await text_provider.clean_transcript(content, language="zh-CN"))
        return optimized if optimized else fallback_optimize_audio_transcript(content)
    except Exception:
        return fallback_optimize_audio_transcript(content)


def image_props_with_caption(props: ImageProps, caption: str) -> ImageProps:
    return props.model_copy(update={"caption": caption})


def looks_like_heading(text: str) -> bool:
    return 0 < len(text.strip()) <= 20


def stroke_bounds(strokes: list[Stroke]) -> tuple[int, int]:
    points = [point for stroke in strokes for point in stroke.points]
    if not points:
        return 320, 120
    width = max(320, math.ceil(max(point.x for point in points) + 24))
    height = max(120, math.ceil(max(point.y for point in points) + 24))
    return width, height


def safe_hex_color(value: str) -> str:
    return value if re.fullmatch(r"#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?", value) else "#111111"


def is_supported_handwriting_bitmap(content_type: str) -> bool:
    return content_type.split(";", 1)[0].strip().lower() in HANDWRITING_BITMAP_CONTENT_TYPES


def render_handwriting_png(strokes: list[Stroke]) -> tuple[bytes, int, int]:
    try:
        from PIL import Image, ImageDraw
    except ModuleNotFoundError as exc:
        raise RuntimeError("Pillow is required to render handwriting strokes.") from exc

    width, height = stroke_bounds(strokes)
    scale = HANDWRITING_RENDER_SCALE
    image = Image.new("RGB", (width * scale, height * scale), "#ffffff")
    draw = ImageDraw.Draw(image)
    for stroke in strokes:
        if not stroke.points:
            continue
        color = "#ffffff" if stroke.tool == "eraser" else safe_hex_color(stroke.color)
        stroke_width = max(1, round(stroke.width * scale))
        points = [(point.x * scale, point.y * scale) for point in stroke.points]
        if len(points) == 1:
            x, y = points[0]
            radius = stroke_width / 2
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
        else:
            draw.line(points, fill=color, width=stroke_width, joint="curve")

    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
    if scale != 1:
        image = image.resize((width, height), resampling)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue(), width, height


async def save_handwriting_render_asset(db: PostgresRepository, owner_id: str, block_id: str, strokes: list[Stroke]) -> AssetRecord:
    content, width, height = render_handwriting_png(strokes)
    now = utcnow()
    checksum = hashlib.sha256(content).hexdigest()
    asset = Asset(
        id=new_id("asset"),
        kind="image",
        filename=f"{block_id}.png",
        content_type="image/png",
        size_bytes=len(content),
        checksum_sha256=checksum,
        duration_ms=None,
        width=width,
        height=height,
        status="ready",
        url=None,
        created_at=now,
        updated_at=now,
    )
    record = AssetRecord(owner_id=owner_id, asset=asset, upload_id=new_id("upload"), part_size_bytes=max(1, len(content)), uploaded_parts=[], content=content)
    await db.save_asset(record)
    return record


async def handwriting_image_record(db: PostgresRepository, owner_id: str, block: ManuscriptHandwritingBlock) -> AssetRecord | None:
    if block.props.image_asset_id:
        record = await get_asset_record(db, block.props.image_asset_id, owner_id)
        if record.asset.kind == "image" and record.asset.status == "ready" and is_supported_handwriting_bitmap(record.asset.content_type):
            return record
        if not block.props.strokes:
            raise validation_error("Handwriting recognition requires a ready bitmap image asset or strokes that can be rendered.")
    if not block.props.strokes:
        return None
    return await save_handwriting_render_asset(db, owner_id, block.id, block.props.strokes)


def strip_json_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    if len(lines) >= 2 and lines[0].startswith("```") and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return stripped


def extract_json_object(text: str) -> str | None:
    stripped = strip_json_fence(text)
    if stripped.startswith("{") and stripped.endswith("}"):
        return stripped
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start != -1 and end > start:
        return stripped[start : end + 1]
    return None


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "y"}
    return bool(value)


def parse_handwriting_result(text: str) -> dict[str, Any]:
    raw = text.strip()
    if not raw:
        return {"recognized_text": "", "has_keepable_drawing": False, "drawing_caption": "", "confidence": None}
    json_object = extract_json_object(raw)
    if json_object is None:
        return {"recognized_text": raw, "has_keepable_drawing": False, "drawing_caption": "", "confidence": None}
    try:
        payload = json.loads(json_object)
    except json.JSONDecodeError:
        return {"recognized_text": raw, "has_keepable_drawing": False, "drawing_caption": "", "confidence": None}
    if not isinstance(payload, dict):
        return {"recognized_text": raw, "has_keepable_drawing": False, "drawing_caption": "", "confidence": None}
    confidence = payload.get("confidence")
    if not isinstance(confidence, (int, float)):
        confidence = None
    return {
        "recognized_text": str(payload.get("recognized_text") or "").strip(),
        "has_keepable_drawing": parse_bool(payload.get("has_keepable_drawing")),
        "drawing_caption": str(payload.get("drawing_caption") or "").strip(),
        "confidence": confidence,
    }


def count_convert_model_units(manuscript: Manuscript, optimize_audio: bool) -> int:
    total = 0
    image_assets: set[str] = set()
    for block in manuscript.blocks:
        if block.deleted:
            continue
        if isinstance(block, ManuscriptAudioBlock) and optimize_audio and (block.props.speaker_segments or block.props.transcript):
            total += max(1, len(block.props.speaker_segments))
        elif isinstance(block, ManuscriptImageBlock) and not (block.props.caption or "").strip():
            image_assets.add(block.props.asset_id)
        elif isinstance(block, ManuscriptHandwritingBlock) and (block.props.strokes or block.props.image_asset_id):
            total += 1
    return total + len(image_assets)


async def build_document_blocks_from_manuscript(
    db: PostgresRepository,
    manuscript: Manuscript,
    task_id: str,
    client_id: str,
    optimize_audio: bool,
    vision_provider: VisionProvider,
    text_provider: TextProvider,
    advance_progress: Any | None = None,
) -> tuple[list[DocumentBlock], list[dict[str, str]]]:
    now = utcnow()
    platform = await device_platform(db, manuscript.owner_id, client_id)
    blocks: list[DocumentBlock] = []
    warnings: list[dict[str, str]] = []
    image_caption_cache: dict[str, str] = {}
    base = {
        "revision": 1,
        "created_at": now,
        "updated_at": now,
        "author_id": manuscript.owner_id,
        "client_id": client_id,
        "platform": platform,
        "deleted": False,
    }
    for source in manuscript.blocks:
        if source.deleted:
            continue
        if isinstance(source, ManuscriptTextBlock) and source.props.content:
            blocks.append(
                DocumentParagraphBlock(
                    id=new_id("doc_block"),
                    type="paragraph",
                    props=TextProps(content=source.props.content),
                    source_refs=source_ref(manuscript.id, source.id),
                    **base,
                )
            )
        elif isinstance(source, ManuscriptAudioBlock):
            segments = sorted(source.props.speaker_segments, key=lambda segment: segment.start_ms)
            if segments:
                for segment in segments:
                    content = segment.text
                    if optimize_audio:
                        content = await optimize_audio_transcript(segment.text, optimize_audio=True, text_provider=text_provider)
                        if advance_progress:
                            await advance_progress("正在优化录音内容")
                    content = speech_paragraph_text(content)
                    if not content:
                        warnings.append(convert_warning(source.id, "audio_transcript_missing", "录音转写为空，已跳过该片段。"))
                        continue
                    blocks.append(
                        DocumentParagraphBlock(
                            id=new_id("doc_block"),
                            type="paragraph",
                            props=TextProps(content=content),
                            source_refs=source_ref(
                                manuscript.id,
                                source.id,
                                SourceRange(start_ms=segment.start_ms, end_ms=segment.end_ms),
                            ),
                            **base,
                        )
                    )
            elif source.props.transcript:
                content = source.props.transcript
                if optimize_audio:
                    content = await optimize_audio_transcript(content, optimize_audio=True, text_provider=text_provider)
                    if advance_progress:
                        await advance_progress("正在优化录音内容")
                content = speech_paragraph_text(content)
                if not content:
                    warnings.append(convert_warning(source.id, "audio_transcript_missing", "录音转写为空，已跳过该录音块。"))
                    continue
                blocks.append(
                    DocumentParagraphBlock(
                        id=new_id("doc_block"),
                        type="paragraph",
                        props=TextProps(content=content),
                        source_refs=source_ref(manuscript.id, source.id),
                        **base,
                    )
                )
            else:
                warnings.append(convert_warning(source.id, "audio_transcript_missing", "录音没有可用转写文本，已跳过。"))
        elif isinstance(source, ManuscriptHandwritingBlock):
            content = (source.props.ai_text or "").strip()
            image_record: AssetRecord | None = None
            if source.props.strokes or source.props.image_asset_id:
                try:
                    image_record = await handwriting_image_record(db, manuscript.owner_id, source)
                    if image_record:
                        result = await vision_provider.recognize(
                            filename=image_record.asset.filename,
                            content_type=image_record.asset.content_type,
                            content=require_asset_content(image_record),
                            width=image_record.asset.width,
                            height=image_record.asset.height,
                            language="zh-CN",
                            prompt=HANDWRITING_RECOGNITION_PROMPT,
                        )
                        parsed = parse_handwriting_result(result.text)
                        content = str(parsed.get("recognized_text") or content).strip()
                        if parsed.get("has_keepable_drawing"):
                            blocks.append(
                                DocumentImageBlock(
                                    id=new_id("doc_block"),
                                    type="image",
                                    props=ImageProps(
                                        asset_id=image_record.asset.id,
                                        caption=str(parsed.get("drawing_caption") or ""),
                                        width=image_record.asset.width,
                                        height=image_record.asset.height,
                                    ),
                                    source_refs=source_ref(manuscript.id, source.id),
                                    **base,
                                )
                            )
                        if advance_progress:
                            await advance_progress("正在识别手写内容")
                except Exception:
                    if image_record:
                        blocks.append(
                            DocumentImageBlock(
                                id=new_id("doc_block"),
                                type="image",
                                props=ImageProps(asset_id=image_record.asset.id, caption="", width=image_record.asset.width, height=image_record.asset.height),
                                source_refs=source_ref(manuscript.id, source.id),
                                **base,
                            )
                        )
                        warnings.append(convert_warning(source.id, "handwriting_recognition_failed", "手写识别失败，已保留手写图片。"))
                    else:
                        warnings.append(convert_warning(source.id, "handwriting_render_failed", "手写渲染失败，已跳过该手写块。"))
                    if advance_progress:
                        await advance_progress("手写处理已降级")
            elif not content:
                warnings.append(convert_warning(source.id, "handwriting_empty", "手写块为空，已跳过。"))
            if content:
                block_type = "heading" if looks_like_heading(content) else "paragraph"
                if block_type == "heading":
                    blocks.append(
                        DocumentHeadingBlock(
                            id=new_id("doc_block"),
                            type="heading",
                            props=HeadingProps(level=2, content=content),
                            source_refs=source_ref(manuscript.id, source.id),
                            **base,
                        )
                    )
                else:
                    blocks.append(
                        DocumentParagraphBlock(
                            id=new_id("doc_block"),
                            type="paragraph",
                            props=TextProps(content=content),
                            source_refs=source_ref(manuscript.id, source.id),
                            **base,
                        )
                    )
        elif isinstance(source, ManuscriptImageBlock):
            caption = (source.props.caption or "").strip()
            if not caption:
                try:
                    requested_caption = False
                    if source.props.asset_id in image_caption_cache:
                        caption = image_caption_cache[source.props.asset_id]
                    else:
                        image_record = await get_asset_record(db, source.props.asset_id, manuscript.owner_id)
                        if image_record.asset.kind != "image" or image_record.asset.status != "ready":
                            raise validation_error("Image block references an unavailable image asset.")
                        result = await vision_provider.recognize(
                            filename=image_record.asset.filename,
                            content_type=image_record.asset.content_type,
                            content=require_asset_content(image_record),
                            width=image_record.asset.width,
                            height=image_record.asset.height,
                            language="zh-CN",
                        )
                        caption = result.caption
                        image_caption_cache[source.props.asset_id] = caption
                        requested_caption = True
                    if requested_caption and advance_progress:
                        await advance_progress("正在生成图片描述")
                except Exception:
                    caption = ""
                    warnings.append(convert_warning(source.id, "image_caption_failed", "图片描述生成失败，已保留原图。"))
                    if advance_progress:
                        await advance_progress("图片描述已降级")
            blocks.append(
                DocumentImageBlock(
                    id=new_id("doc_block"),
                    type="image",
                    props=image_props_with_caption(source.props, caption),
                    source_refs=source_ref(manuscript.id, source.id),
                    **base,
                )
            )
    if not blocks:
        blocks.append(
            DocumentParagraphBlock(
                id=new_id("doc_block"),
                type="paragraph",
                props=TextProps(content=""),
                source_refs=[],
                **base,
            )
        )
    return blocks, warnings


def document_plain_text(document: Document) -> str:
    parts: list[str] = [document.title]
    for block in document.blocks:
        if block.deleted:
            continue
        props = block.props
        if isinstance(props, (TextProps, HeadingProps, QuoteProps, CodeProps)):
            parts.append(props.content)
        elif isinstance(props, ListProps):
            parts.extend(props.items)
        elif isinstance(props, TableProps):
            parts.extend("\t".join(row) for row in props.rows)
        elif isinstance(props, ImageProps) and props.caption:
            parts.append(props.caption)
    return "\n".join(parts)


def render_export_content(document: Document, export_format: Literal["pdf", "docx"]) -> bytes:
    text = document_plain_text(document)
    if export_format == "pdf":
        payload = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        return (
            "%PDF-1.4\n"
            "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
            "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
            "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj\n"
            f"4 0 obj << /Length {len(payload) + 32} >> stream\nBT /F1 12 Tf 72 720 Td ({payload}) Tj ET\nendstream endobj\n"
            "%%EOF\n"
        ).encode("utf-8")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<?xml version='1.0' encoding='UTF-8'?><Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><Default Extension='xml' ContentType='application/xml'/><Override PartName='/word/document.xml' ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'/></Types>")
        archive.writestr("_rels/.rels", "<?xml version='1.0' encoding='UTF-8'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' Target='word/document.xml'/></Relationships>")
        escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        archive.writestr("word/document.xml", f"<?xml version='1.0' encoding='UTF-8'?><w:document xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'><w:body><w:p><w:r><w:t>{escaped}</w:t></w:r></w:p></w:body></w:document>")
    return buffer.getvalue()


def speaker_segments_from_asr(result: AsrResult) -> list[SpeakerSegment]:
    return [
        SpeakerSegment(
            speaker_id=segment.speaker_id,
            start_ms=segment.start_ms,
            end_ms=segment.end_ms,
            text=segment.text,
            confidence=segment.confidence,
        )
        for segment in result.speaker_segments
    ]


async def apply_asr_result_to_manuscripts(
    db: PostgresRepository,
    owner_id: str,
    asset_id: str,
    task_id: str,
    result: AsrResult,
    generated_at: datetime,
) -> None:
    segments = speaker_segments_from_asr(result)
    manuscripts = await db.list_manuscripts(owner_id, include_deleted=True)
    for manuscript in manuscripts:
        changed = False
        updated_blocks: list[ManuscriptBlock] = []
        for block in manuscript.blocks:
            if isinstance(block, ManuscriptAudioBlock) and block.props.asset_id == asset_id:
                props = block.props.model_copy(
                    update={
                        "transcript": result.transcript,
                        "speaker_segments": segments,
                        "asr_task_id": task_id,
                        "asr_generated_at": generated_at,
                    }
                )
                updated_blocks.append(block.model_copy(update={"props": props, "revision": block.revision + 1, "updated_at": generated_at}))
                changed = True
            else:
                updated_blocks.append(block)
        if changed:
            manuscript.blocks = updated_blocks
            manuscript.revision += 1
            manuscript.updated_at = generated_at
            await db.save_manuscript(manuscript)


async def apply_image_result_to_manuscripts(
    db: PostgresRepository,
    owner_id: str,
    asset_id: str,
    task_id: str,
    result: VisionResult,
    generated_at: datetime,
) -> None:
    manuscripts = await db.list_manuscripts(owner_id, include_deleted=True)
    for manuscript in manuscripts:
        changed = False
        updated_blocks: list[ManuscriptBlock] = []
        for block in manuscript.blocks:
            if isinstance(block, ManuscriptImageBlock) and block.props.asset_id == asset_id:
                if (block.props.caption or "").strip():
                    updated_blocks.append(block)
                    continue
                props = block.props.model_copy(
                    update={
                        "caption": result.caption or result.text or block.props.caption,
                        "recognition_task_id": task_id,
                        "recognition_generated_at": generated_at,
                    }
                )
                updated_blocks.append(block.model_copy(update={"props": props, "revision": block.revision + 1, "updated_at": generated_at}))
                changed = True
            else:
                updated_blocks.append(block)
        if changed:
            manuscript.blocks = updated_blocks
            manuscript.revision += 1
            manuscript.updated_at = generated_at
            await db.save_manuscript(manuscript)


async def save_failed_asr_task(db: PostgresRepository, owner_id: str, task: Task, message: str, retryable: bool) -> None:
    failed = task.model_copy(
        update={
            "status": "failed",
            "progress": TaskProgress(stage="completed", current=0, total=1, message="ASR task failed."),
            "error": TaskError(code="ai_unavailable" if retryable else "validation_error", message=message, retryable=retryable),
            "updated_at": utcnow(),
        }
    )
    await db.save_task(owner_id, failed)


async def save_failed_image_task(db: PostgresRepository, owner_id: str, task: Task, message: str, retryable: bool) -> None:
    failed = task.model_copy(
        update={
            "status": "failed",
            "progress": TaskProgress(stage="completed", current=0, total=1, message="Image recognition task failed."),
            "error": TaskError(code="ai_unavailable" if retryable else "validation_error", message=message, retryable=retryable),
            "updated_at": utcnow(),
        }
    )
    await db.save_task(owner_id, failed)


def provider_task_error_code(retryable: bool) -> str:
    return "ai_unavailable" if retryable else "validation_error"


def sse_event(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(jsonable_encoder(data), ensure_ascii=False)}\n\n"


async def process_asr_task(
    db: PostgresRepository,
    owner_id: str,
    task_id: str,
    payload: AsrAudioRequest,
    provider: AsrProvider,
) -> None:
    task = await get_task(db, task_id, owner_id)
    if task.status == "cancelled":
        return

    processing = task.model_copy(
        update={
            "status": "processing",
            "progress": TaskProgress(stage="asr", current=0, total=1, message="ASR task processing."),
            "updated_at": utcnow(),
        }
    )
    await db.save_task(owner_id, processing)

    try:
        asset_record = await get_asset_record(db, payload.asset_id, owner_id)
        if asset_record.asset.kind != "audio" or asset_record.asset.status != "ready":
            raise validation_error("ASR requires a ready audio asset.")
        content = require_asset_content(asset_record)
        result = await provider.transcribe(
            filename=asset_record.asset.filename,
            content_type=asset_record.asset.content_type,
            content=content,
            duration_ms=asset_record.asset.duration_ms,
            language=payload.language,
            enable_diarization=payload.enable_diarization,
        )
        generated_at = utcnow()
        await apply_asr_result_to_manuscripts(db, owner_id, payload.asset_id, task_id, result, generated_at)
        completed = processing.model_copy(
            update={
                "status": "succeeded",
                "progress": TaskProgress(stage="completed", current=1, total=1, message="ASR task completed."),
                "result": {
                    "asset_id": payload.asset_id,
                    "transcript": result.transcript,
                    "speaker_segments": [segment.model_dump(mode="json") for segment in speaker_segments_from_asr(result)],
                },
                "error": None,
                "updated_at": generated_at,
            }
        )
        await db.save_task(owner_id, completed)
    except APIError as exc:
        await save_failed_asr_task(db, owner_id, processing, exc.message, retryable=False)
    except AsrProviderError as exc:
        await save_failed_asr_task(db, owner_id, processing, exc.message, retryable=exc.retryable)
    except Exception:
        await save_failed_asr_task(db, owner_id, processing, "ASR service is temporarily unavailable.", retryable=True)


async def stream_asr_task_events(
    db: PostgresRepository,
    owner_id: str,
    task: Task,
    payload: AsrAudioRequest,
    provider: AsrProvider,
) -> AsyncIterator[str]:
    yield sse_event("task", {"task": task})
    processing = task.model_copy(
        update={
            "status": "processing",
            "progress": TaskProgress(stage="asr", current=0, total=1, message="ASR task processing."),
            "updated_at": utcnow(),
        }
    )
    await db.save_task(owner_id, processing)
    yield sse_event("task", {"task": processing})
    try:
        asset_record = await get_asset_record(db, payload.asset_id, owner_id)
        if asset_record.asset.kind != "audio" or asset_record.asset.status != "ready":
            raise validation_error("ASR requires a ready audio asset.")
        content = require_asset_content(asset_record)
        current_text = ""
        async for chunk in provider.stream_transcribe(
            filename=asset_record.asset.filename,
            content_type=asset_record.asset.content_type,
            content=content,
            duration_ms=asset_record.asset.duration_ms,
            language=payload.language,
            enable_diarization=payload.enable_diarization,
        ):
            current_text, delta = stream_delta(current_text, chunk)
            if delta:
                yield sse_event("delta", {"task_id": task.id, "text": delta, "transcript": current_text})

        result = result_from_text(current_text, asset_record.asset.duration_ms, payload.enable_diarization)
        generated_at = utcnow()
        await apply_asr_result_to_manuscripts(db, owner_id, payload.asset_id, task.id, result, generated_at)
        completed = processing.model_copy(
            update={
                "status": "succeeded",
                "progress": TaskProgress(stage="completed", current=1, total=1, message="ASR task completed."),
                "result": {
                    "asset_id": payload.asset_id,
                    "transcript": result.transcript,
                    "speaker_segments": [segment.model_dump(mode="json") for segment in speaker_segments_from_asr(result)],
                },
                "error": None,
                "updated_at": generated_at,
            }
        )
        await db.save_task(owner_id, completed)
        yield sse_event("done", {"task": completed})
    except APIError as exc:
        await save_failed_asr_task(db, owner_id, processing, exc.message, retryable=False)
        yield sse_event("error", {"code": "validation_error", "message": exc.message})
    except AsrProviderError as exc:
        await save_failed_asr_task(db, owner_id, processing, exc.message, retryable=exc.retryable)
        yield sse_event("error", {"code": provider_task_error_code(exc.retryable), "message": exc.message})
    except Exception:
        message = "ASR service is temporarily unavailable."
        await save_failed_asr_task(db, owner_id, processing, message, retryable=True)
        yield sse_event("error", {"code": "ai_unavailable", "message": message})


async def process_image_task(
    db: PostgresRepository,
    owner_id: str,
    task_id: str,
    payload: RecognizeImageRequest,
    provider: VisionProvider,
) -> None:
    task = await get_task(db, task_id, owner_id)
    if task.status == "cancelled":
        return

    processing = task.model_copy(
        update={
            "status": "processing",
            "progress": TaskProgress(stage="llm_parse", current=0, total=1, message="Image recognition task processing."),
            "updated_at": utcnow(),
        }
    )
    await db.save_task(owner_id, processing)

    try:
        asset_record = await get_asset_record(db, payload.asset_id, owner_id)
        if asset_record.asset.kind != "image" or asset_record.asset.status != "ready":
            raise validation_error("Image recognition requires a ready image asset.")
        content = require_asset_content(asset_record)
        result = await provider.recognize(
            filename=asset_record.asset.filename,
            content_type=asset_record.asset.content_type,
            content=content,
            width=asset_record.asset.width,
            height=asset_record.asset.height,
            language=payload.language,
        )
        generated_at = utcnow()
        await apply_image_result_to_manuscripts(db, owner_id, payload.asset_id, task_id, result, generated_at)
        completed = processing.model_copy(
            update={
                "status": "succeeded",
                "progress": TaskProgress(stage="completed", current=1, total=1, message="Image recognition task completed."),
                "result": {
                    "asset_id": payload.asset_id,
                    "caption": result.caption,
                    "text": result.text,
                },
                "error": None,
                "updated_at": generated_at,
            }
        )
        await db.save_task(owner_id, completed)
    except APIError as exc:
        await save_failed_image_task(db, owner_id, processing, exc.message, retryable=False)
    except VisionProviderError as exc:
        await save_failed_image_task(db, owner_id, processing, exc.message, retryable=exc.retryable)
    except Exception:
        await save_failed_image_task(db, owner_id, processing, "Image recognition service is temporarily unavailable.", retryable=True)


async def stream_image_task_events(
    db: PostgresRepository,
    owner_id: str,
    task: Task,
    payload: RecognizeImageRequest,
    provider: VisionProvider,
) -> AsyncIterator[str]:
    yield sse_event("task", {"task": task})
    processing = task.model_copy(
        update={
            "status": "processing",
            "progress": TaskProgress(stage="llm_parse", current=0, total=1, message="Image recognition task processing."),
            "updated_at": utcnow(),
        }
    )
    await db.save_task(owner_id, processing)
    yield sse_event("task", {"task": processing})
    try:
        asset_record = await get_asset_record(db, payload.asset_id, owner_id)
        if asset_record.asset.kind != "image" or asset_record.asset.status != "ready":
            raise validation_error("Image recognition requires a ready image asset.")
        content = require_asset_content(asset_record)
        current_text = ""
        async for chunk in provider.stream_recognize(
            filename=asset_record.asset.filename,
            content_type=asset_record.asset.content_type,
            content=content,
            width=asset_record.asset.width,
            height=asset_record.asset.height,
            language=payload.language,
        ):
            current_text, delta = stream_delta(current_text, chunk)
            if delta:
                result = vision_result_from_text(current_text)
                yield sse_event("delta", {"task_id": task.id, "text": delta, "caption": result.caption, "recognized_text": current_text})

        result = vision_result_from_text(current_text)
        generated_at = utcnow()
        await apply_image_result_to_manuscripts(db, owner_id, payload.asset_id, task.id, result, generated_at)
        completed = processing.model_copy(
            update={
                "status": "succeeded",
                "progress": TaskProgress(stage="completed", current=1, total=1, message="Image recognition task completed."),
                "result": {
                    "asset_id": payload.asset_id,
                    "caption": result.caption,
                    "text": result.text,
                },
                "error": None,
                "updated_at": generated_at,
            }
        )
        await db.save_task(owner_id, completed)
        yield sse_event("done", {"task": completed})
    except APIError as exc:
        await save_failed_image_task(db, owner_id, processing, exc.message, retryable=False)
        yield sse_event("error", {"code": "validation_error", "message": exc.message})
    except VisionProviderError as exc:
        await save_failed_image_task(db, owner_id, processing, exc.message, retryable=exc.retryable)
        yield sse_event("error", {"code": provider_task_error_code(exc.retryable), "message": exc.message})
    except Exception:
        message = "Image recognition service is temporarily unavailable."
        await save_failed_image_task(db, owner_id, processing, message, retryable=True)
        yield sse_event("error", {"code": "ai_unavailable", "message": message})


async def process_convert_task(
    db: PostgresRepository,
    owner_id: str,
    task_id: str,
    manuscript: Manuscript,
    payload: ConvertManuscriptRequest,
    provider: VisionProvider,
    text_provider: TextProvider,
) -> None:
    task = await get_task(db, task_id, owner_id)
    if task.status == "cancelled":
        return

    total = max(2, count_convert_model_units(manuscript, payload.optimize_audio) + 2)
    current = 1
    state = task.model_copy(
        update={
            "status": "processing",
            "progress": TaskProgress(stage="llm_parse", current=current, total=total, message="正在分析手稿处理单元"),
            "updated_at": utcnow(),
        }
    )
    await db.save_task(owner_id, state)

    async def advance_progress(message: str) -> None:
        nonlocal current, state
        current = min(total - 1, current + 1)
        state = state.model_copy(
            update={
                "progress": TaskProgress(stage="llm_parse", current=current, total=total, message=message),
                "updated_at": utcnow(),
            }
        )
        await db.save_task(owner_id, state)

    try:
        blocks, warnings = await build_document_blocks_from_manuscript(
            db,
            manuscript,
            task_id,
            payload.client_id,
            payload.optimize_audio,
            provider,
            text_provider,
            advance_progress,
        )
        latest = await get_task(db, task_id, owner_id)
        if latest.status == "cancelled":
            return

        state = state.model_copy(
            update={
                "progress": TaskProgress(stage="document_build", current=total - 1, total=total, message="正在组装文档"),
                "updated_at": utcnow(),
            }
        )
        await db.save_task(owner_id, state)

        now = utcnow()
        derived_from = DerivedFrom(manuscript_id=manuscript.id, task_id=task_id, mode=payload.mode, converted_at=now)
        document = Document(
            id=new_id("doc"),
            title=payload.title,
            owner_id=owner_id,
            source_manuscript_ids=[manuscript.id],
            derived_from=derived_from,
            revision=1,
            blocks=blocks,
            permission="owner",
            created_at=now,
            updated_at=now,
        )
        await db.save_document(document)
        await db.create_document_version(document, "Converted from manuscript")
        result: dict[str, Any] = {"document_id": document.id}
        if warnings:
            result["warnings"] = warnings
        completed = state.model_copy(
            update={
                "status": "succeeded",
                "progress": TaskProgress(stage="completed", current=total, total=total, message="转换完成"),
                "result": result,
                "error": None,
                "updated_at": now,
            }
        )
        await db.save_task(owner_id, completed)
    except APIError as exc:
        failed = state.model_copy(
            update={
                "status": "failed",
                "progress": TaskProgress(stage="completed", current=current, total=total, message="转换失败"),
                "error": TaskError(code=exc.code, message=exc.message, retryable=False),
                "updated_at": utcnow(),
            }
        )
        await db.save_task(owner_id, failed)
    except Exception:
        failed = state.model_copy(
            update={
                "status": "failed",
                "progress": TaskProgress(stage="completed", current=current, total=total, message="转换失败"),
                "error": TaskError(code="internal_error", message="Manuscript conversion failed.", retryable=True),
                "updated_at": utcnow(),
            }
        )
        await db.save_task(owner_id, failed)


app = FastAPI(
    title="MeetingMate Backend",
    version="0.1.0",
    description="FastAPI/Pydantic API contract implementation for MeetingMate MVP.",
    openapi_version="3.1.0",
    default_response_class=ContractJSONResponse,
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-Id", "ETag", "Content-Length", "Content-Disposition", "Accept-Ranges"],
)
if settings.allowed_hosts:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
router = APIRouter(prefix=API_PREFIX, responses=ERROR_RESPONSES)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request.state.request_id = request.headers.get("X-Request-Id") or new_id("req")
    response = await call_next(request)
    response.headers["X-Request-Id"] = request.state.request_id
    return response


@app.exception_handler(APIError)
async def api_error_handler(request: Request, exc: APIError) -> JSONResponse:
    return make_error_response(request, exc.status_code, exc.code, exc.message, exc.details)


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return make_error_response(
        request,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "validation_error",
        "Request validation failed.",
        {"errors": exc.errors()},
    )


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = "not_found" if exc.status_code == 404 else "invalid_request"
    return make_error_response(request, exc.status_code, code, str(exc.detail))


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    return make_error_response(request, status.HTTP_500_INTERNAL_SERVER_ERROR, "internal_error", "Internal server error.")


@app.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse | JSONResponse:
    database_state: DatabaseState = getattr(app.state, "database", DatabaseState())
    if not await check_database(database_state):
        return ContractJSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"status": "degraded", "database": "unavailable", "pgvector": None},
        )
    return HealthResponse(
        status="ok",
        database="ok",
        pgvector="enabled" if database_state.vector_enabled else "disabled",
    )


@router.post("/auth/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(payload: RegisterRequest, db: PostgresRepository = Depends(get_repository)) -> AuthResponse:
    email = str(payload.email).lower()
    if await db.get_user_record_by_email(email):
        raise APIError(status.HTTP_409_CONFLICT, "resource_conflict", "Email is already registered.")
    now = utcnow()
    user = User(id=new_id("u"), email=email, name=payload.name, avatar_url=None, created_at=now)
    await db.create_user(user, password_hash(payload.password))
    await db.upsert_device(user.id, payload.device)
    return await db.create_tokens(user.id, payload.device.client_id)


@router.post("/auth/login", response_model=AuthResponse)
async def login(payload: LoginRequest, db: PostgresRepository = Depends(get_repository)) -> AuthResponse:
    email = str(payload.email).lower()
    user_record = await db.get_user_record_by_email(email)
    if not user_record:
        raise APIError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Email or password is invalid.")
    if not verify_password(payload.password, user_record.password_hash):
        raise APIError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Email or password is invalid.")
    await db.upsert_device(user_record.user.id, payload.device)
    return await db.create_tokens(user_record.user.id, payload.device.client_id)


@router.post("/auth/refresh", response_model=AuthResponse)
async def refresh_token(payload: RefreshRequest, db: PostgresRepository = Depends(get_repository)) -> AuthResponse:
    session = await db.get_token_session(payload.refresh_token, "refresh")
    if not session or session.expires_at <= utcnow() or session.client_id != payload.client_id:
        raise APIError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Refresh token is missing, expired, or invalid.")
    await db.delete_token(payload.refresh_token)
    await db.touch_device(session.user_id, session.client_id)
    return await db.create_tokens(session.user_id, session.client_id)


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def logout(
    request: Request,
    payload: LogoutRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> Response:
    require_client_header(request, ctx, payload.client_id)
    await db.delete_tokens_for_client(ctx.user_id, payload.client_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/devices", response_model=DeviceListResponse)
async def list_devices(
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> DeviceListResponse:
    devices = await db.list_devices(ctx.user_id)
    page, next_cursor = paginate(devices, limit, cursor)
    return DeviceListResponse(items=page, next_cursor=next_cursor)


@router.delete("/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def revoke_device(
    device_id: str,
    request: Request,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> Response:
    require_client_header(request, ctx)
    if not await db.delete_device(ctx.user_id, device_id):
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Device not found.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/assets/upload", response_model=AssetUploadResponse, status_code=status.HTTP_201_CREATED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def create_asset_upload(
    request: Request,
    payload: AssetUploadRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    require_client_header(request, ctx)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_201_CREATED)
    now = utcnow()
    asset_id = new_id("asset")
    upload_id = new_id("upload")
    asset = Asset(
        id=asset_id,
        kind=payload.kind,
        filename=payload.filename,
        content_type=payload.content_type,
        size_bytes=payload.size_bytes,
        checksum_sha256=payload.checksum_sha256,
        duration_ms=None,
        width=None,
        height=None,
        status="pending_upload",
        url=None,
        created_at=now,
        updated_at=now,
    )
    record = AssetRecord(owner_id=ctx.user_id, asset=asset, upload_id=upload_id, part_size_bytes=payload.part_size_bytes, uploaded_parts=[])
    await db.save_asset(record)
    response = AssetUploadResponse(
        asset_id=asset_id,
        upload_id=upload_id,
        part_size_bytes=payload.part_size_bytes,
        parts=make_presigned_parts(request, asset_id, upload_id, payload.content_type, payload.part_size_bytes, payload.size_bytes),
    )
    return await idempotent_json_response(db, idem, response, status.HTTP_201_CREATED)


@router.get("/assets/{asset_id}/upload-parts", response_model=AssetUploadPartsResponse)
async def get_asset_upload_parts(
    asset_id: str,
    request: Request,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> AssetUploadPartsResponse:
    record = await get_asset_record(db, asset_id, ctx.user_id)
    all_parts = make_presigned_parts(request, record.asset.id, record.upload_id, record.asset.content_type, record.part_size_bytes, record.asset.size_bytes)
    uploaded_numbers = {part.part_number for part in record.uploaded_parts}
    missing = [part for part in all_parts if part.part_number not in uploaded_numbers]
    return AssetUploadPartsResponse(
        asset_id=asset_id,
        upload_id=record.upload_id,
        part_size_bytes=record.part_size_bytes,
        uploaded_parts=record.uploaded_parts,
        missing_parts=missing,
    )


@router.put("/assets/{asset_id}/upload-parts/{part_number}", response_model=UploadedPart)
async def upload_asset_part(
    asset_id: str,
    part_number: int,
    request: Request,
    upload_id: str,
    expires_at: int,
    signature: str,
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    if expires_at < int(utcnow().timestamp()):
        raise APIError(status.HTTP_400_BAD_REQUEST, "invalid_request", "Upload URL has expired.")
    expected_signature = upload_part_signature(asset_id, upload_id, part_number, expires_at)
    if not secrets.compare_digest(signature, expected_signature):
        raise APIError(status.HTTP_403_FORBIDDEN, "forbidden", "Upload URL signature is invalid.")
    record = await db.get_asset_record(asset_id)
    if not record or record.upload_id != upload_id:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Asset upload not found.")
    if record.asset.status not in {"pending_upload", "uploaded"}:
        raise APIError(status.HTTP_409_CONFLICT, "resource_conflict", "Asset is not accepting uploads.")
    expected_part_count = max(1, math.ceil(record.asset.size_bytes / record.part_size_bytes))
    if part_number < 1 or part_number > expected_part_count:
        raise validation_error("part_number is outside the expected upload range.")

    content = await request.body()
    max_part_size = record.part_size_bytes
    if part_number < expected_part_count and len(content) != max_part_size:
        raise validation_error("Non-final upload parts must match part_size_bytes.")
    if part_number == expected_part_count and len(content) > max_part_size:
        raise validation_error("Final upload part exceeds part_size_bytes.")
    etag = hashlib.sha256(content).hexdigest()
    record.part_contents[part_number] = content
    uploaded_by_number = {part.part_number: part for part in record.uploaded_parts}
    uploaded_part = UploadedPart(part_number=part_number, etag=etag, size_bytes=len(content))
    uploaded_by_number[part_number] = uploaded_part
    record.uploaded_parts = [uploaded_by_number[number] for number in sorted(uploaded_by_number)]
    if len(record.uploaded_parts) == expected_part_count:
        record.asset = record.asset.model_copy(update={"status": "uploaded", "updated_at": utcnow()})
    await db.save_asset(record)
    return ContractJSONResponse(content=jsonable_encoder(uploaded_part), status_code=status.HTTP_200_OK, headers={"ETag": etag})


@router.post("/assets/{asset_id}/complete", response_model=Asset, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def complete_asset_upload(
    asset_id: str,
    request: Request,
    payload: AssetCompleteRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    require_client_header(request, ctx)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_200_OK)
    record = await get_asset_record(db, asset_id, ctx.user_id)
    if payload.upload_id != record.upload_id:
        record.asset = record.asset.model_copy(update={"status": "failed", "updated_at": utcnow()})
        await db.save_asset(record)
        raise validation_error("upload_id does not match asset upload.")
    if payload.size_bytes != record.asset.size_bytes or payload.checksum_sha256 != record.asset.checksum_sha256:
        record.asset = record.asset.model_copy(update={"status": "failed", "updated_at": utcnow()})
        await db.save_asset(record)
        raise validation_error("size_bytes or checksum_sha256 does not match the upload request.")
    try:
        validate_complete_parts(payload)
    except APIError:
        record.asset = record.asset.model_copy(update={"status": "failed", "updated_at": utcnow()})
        await db.save_asset(record)
        raise
    uploaded_by_number = {part.part_number: part for part in record.uploaded_parts}
    sorted_parts = sorted(payload.parts, key=lambda item: item.part_number)
    for part in sorted_parts:
        uploaded_part = uploaded_by_number.get(part.part_number)
        if not uploaded_part or uploaded_part.etag != part.etag or uploaded_part.size_bytes != part.size_bytes:
            record.asset = record.asset.model_copy(update={"status": "failed", "updated_at": utcnow()})
            await db.save_asset(record)
            raise validation_error("Uploaded part metadata does not match the completed parts payload.")

    content = collect_part_contents(record, sorted_parts)
    if content is not None:
        if len(content) != payload.size_bytes or hashlib.sha256(content).hexdigest() != payload.checksum_sha256:
            record.asset = record.asset.model_copy(update={"status": "failed", "updated_at": utcnow()})
            await db.save_asset(record)
            raise validation_error("Uploaded content does not match size_bytes or checksum_sha256.")
        record.content = content
    else:
        record.asset = record.asset.model_copy(update={"status": "failed", "updated_at": utcnow()})
        await db.save_asset(record)
        raise validation_error("Uploaded part content is missing from database storage.")
    record.uploaded_parts = sorted(payload.parts, key=lambda part: part.part_number)
    record.asset = record.asset.model_copy(
        update={
            "status": "ready",
            "duration_ms": payload.duration_ms,
            "width": payload.width,
            "height": payload.height,
            "updated_at": utcnow(),
        }
    )
    await db.save_asset(record)
    return await idempotent_json_response(db, idem, record.asset, status.HTTP_200_OK)


@router.get("/assets/{asset_id}", response_model=Asset)
async def get_asset(asset_id: str, ctx: AuthContext = Depends(auth_context), db: PostgresRepository = Depends(get_repository)) -> Asset:
    record = await get_asset_record(db, asset_id, ctx.user_id)
    return record.asset.model_copy(update={"url": None})


@router.get("/assets/{asset_id}/stream")
async def stream_asset(asset_id: str, ctx: AuthContext = Depends(auth_context), db: PostgresRepository = Depends(get_repository)) -> Response:
    record = await get_asset_record(db, asset_id, ctx.user_id)
    content = asset_content_bytes(record)
    if content is not None and record.asset.status in {"uploaded", "ready"}:
        return Response(
            content=content,
            media_type=record.asset.content_type,
            headers={
                "Content-Length": str(len(content)),
                "Content-Disposition": content_disposition_filename(record.asset.filename),
                "Accept-Ranges": "bytes",
            },
        )
    raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Asset content is not available.")


@router.delete("/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def delete_asset(
    asset_id: str,
    request: Request,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> Response:
    require_client_header(request, ctx)
    record = await get_asset_record(db, asset_id, ctx.user_id)
    if await db.asset_is_referenced(ctx.user_id, asset_id):
        raise APIError(status.HTTP_409_CONFLICT, "resource_conflict", "Asset is still referenced.", {"reason": "still_referenced"})
    await db.delete_asset(record.asset.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/manuscripts", response_model=ManuscriptListResponse)
async def list_manuscripts(
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> ManuscriptListResponse:
    manuscripts = await db.list_manuscripts(ctx.user_id)
    summaries = [manuscript_summary(item) for item in manuscripts]
    page, next_cursor = paginate(summaries, limit, cursor)
    return ManuscriptListResponse(items=page, next_cursor=next_cursor)


@router.post("/manuscripts", response_model=Manuscript, status_code=status.HTTP_201_CREATED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def create_manuscript(
    request: Request,
    payload: ManuscriptCreateRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    client_id = require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_201_CREATED)
    now = utcnow()
    blocks: list[ManuscriptBlock] = []
    for block in payload.initial_blocks:
        validate_block_author_and_client(block, ctx, client_id)
        validate_block_payload(block)
        await validate_block_asset_refs(db, block, ctx.user_id)
        blocks.append(block.model_copy(update={"updated_at": now}))
    manuscript = Manuscript(
        id=new_id("m"),
        title=payload.title,
        owner_id=ctx.user_id,
        revision=1,
        blocks=blocks,
        created_at=now,
        updated_at=now,
    )
    await db.save_manuscript(manuscript)
    return await idempotent_json_response(db, idem, manuscript, status.HTTP_201_CREATED)


@router.get("/manuscripts/{manuscript_id}", response_model=Manuscript)
async def get_manuscript_route(manuscript_id: str, ctx: AuthContext = Depends(auth_context), db: PostgresRepository = Depends(get_repository)) -> Manuscript:
    return await get_manuscript(db, manuscript_id, ctx.user_id)


@router.get("/manuscripts/{manuscript_id}/blocks", response_model=ManuscriptBlockListResponse)
async def list_manuscript_blocks(
    manuscript_id: str,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = MAX_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> ManuscriptBlockListResponse:
    manuscript = await get_manuscript(db, manuscript_id, ctx.user_id)
    page, next_cursor = paginate(manuscript.blocks, limit, cursor)
    return ManuscriptBlockListResponse(items=page, next_cursor=next_cursor, revision=manuscript.revision)


@router.put("/manuscripts/{manuscript_id}/blocks", response_model=ManuscriptSyncResponse, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def sync_manuscript_blocks(
    manuscript_id: str,
    request: Request,
    payload: ManuscriptSyncRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    client_id = require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_200_OK)
    manuscript = await get_manuscript(db, manuscript_id, ctx.user_id)
    if payload.base_revision != manuscript.revision:
        raise APIError(
            status.HTTP_409_CONFLICT,
            "revision_conflict",
            "Manuscript revision is outdated.",
            {"server_revision": manuscript.revision, "client_revision": payload.base_revision, "latest_blocks": [dump_model(block) for block in manuscript.blocks]},
        )
    changed, applied = await apply_manuscript_operations(db, manuscript, payload, ctx, client_id)
    await db.save_manuscript(manuscript)
    response = ManuscriptSyncResponse(resource_id=manuscript.id, revision=manuscript.revision, applied_op_ids=applied, conflicts=[], blocks=changed)
    return await idempotent_json_response(db, idem, response, status.HTTP_200_OK)


@router.delete("/manuscripts/{manuscript_id}", response_model=DeletedManuscriptResponse, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def delete_manuscript(
    manuscript_id: str,
    request: Request,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> DeletedManuscriptResponse:
    require_client_header(request, ctx)
    manuscript = await get_manuscript(db, manuscript_id, ctx.user_id)
    now = utcnow()
    manuscript.deleted = True
    manuscript.deleted_at = now
    manuscript.updated_at = now
    manuscript.revision += 1
    await db.save_manuscript(manuscript)
    return DeletedManuscriptResponse(id=manuscript.id, deleted=True, deleted_at=now)


@router.get("/documents", response_model=DocumentListResponse)
async def list_documents(
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> DocumentListResponse:
    documents = await db.list_documents(ctx.user_id)
    summaries = [document_summary(item) for item in documents]
    page, next_cursor = paginate(summaries, limit, cursor)
    return DocumentListResponse(items=page, next_cursor=next_cursor)


@router.post("/documents", response_model=Document, status_code=status.HTTP_201_CREATED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def create_document(
    request: Request,
    payload: DocumentCreateRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    client_id = require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_201_CREATED)
    if payload.derived_from is not None:
        raise validation_error("derived_from is server-managed and must be null for manual document creation.")
    now = utcnow()
    for manuscript_id in payload.source_manuscript_ids:
        await get_manuscript(db, manuscript_id, ctx.user_id)
    blocks: list[DocumentBlock] = []
    for block in payload.initial_blocks:
        validate_block_author_and_client(block, ctx, client_id)
        validate_block_payload(block)
        await validate_block_asset_refs(db, block, ctx.user_id)
        blocks.append(block.model_copy(update={"updated_at": now, "source_refs": []}))
    document = Document(
        id=new_id("doc"),
        title=payload.title,
        owner_id=ctx.user_id,
        source_manuscript_ids=payload.source_manuscript_ids,
        derived_from=payload.derived_from,
        revision=1,
        blocks=blocks,
        permission="owner",
        created_at=now,
        updated_at=now,
    )
    await db.save_document(document)
    await db.create_document_version(document, "Initial version")
    return await idempotent_json_response(db, idem, document, status.HTTP_201_CREATED)


@router.get("/documents/{document_id}", response_model=Document)
async def get_document_route(document_id: str, ctx: AuthContext = Depends(auth_context), db: PostgresRepository = Depends(get_repository)) -> Document:
    return await get_document(db, document_id, ctx.user_id)


@router.get("/documents/{document_id}/blocks", response_model=DocumentBlockListResponse)
async def list_document_blocks(
    document_id: str,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = MAX_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> DocumentBlockListResponse:
    document = await get_document(db, document_id, ctx.user_id)
    page, next_cursor = paginate(document.blocks, limit, cursor)
    return DocumentBlockListResponse(items=page, next_cursor=next_cursor, revision=document.revision)


@router.put("/documents/{document_id}/blocks", response_model=DocumentSyncResponse, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def sync_document_blocks(
    document_id: str,
    request: Request,
    payload: DocumentSyncRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    client_id = require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_200_OK)
    document = await get_document(db, document_id, ctx.user_id)
    if payload.base_revision != document.revision:
        raise APIError(
            status.HTTP_409_CONFLICT,
            "revision_conflict",
            "Document revision is outdated.",
            {"server_revision": document.revision, "client_revision": payload.base_revision, "latest_blocks": [dump_model(block) for block in document.blocks]},
        )
    changed, applied = await apply_document_operations(db, document, payload, ctx, client_id)
    await db.save_document(document)
    await db.create_document_version(document, "Automatic version")
    response = DocumentSyncResponse(resource_id=document.id, revision=document.revision, applied_op_ids=applied, conflicts=[], blocks=changed)
    return await idempotent_json_response(db, idem, response, status.HTTP_200_OK)


@router.get("/documents/{document_id}/versions", response_model=DocumentVersionListResponse)
async def list_document_versions(
    document_id: str,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> DocumentVersionListResponse:
    await get_document(db, document_id, ctx.user_id)
    versions = await db.list_document_versions(document_id)
    page, next_cursor = paginate(versions, limit, cursor)
    return DocumentVersionListResponse(items=page, next_cursor=next_cursor)


@router.post("/documents/{document_id}/versions/{version_id}/restore", response_model=Document, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def restore_document_version(
    document_id: str,
    version_id: str,
    request: Request,
    payload: RestoreVersionRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> Document:
    require_client_header(request, ctx, payload.client_id)
    document = await get_document(db, document_id, ctx.user_id)
    if payload.base_revision != document.revision:
        raise APIError(status.HTTP_409_CONFLICT, "revision_conflict", "Document revision is outdated.", {"server_revision": document.revision, "client_revision": payload.base_revision})
    version_record = await db.find_document_version(document_id, version_id)
    if not version_record:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Document version not found.")
    restored = version_record.snapshot.model_copy(deep=True)
    document.title = restored.title
    document.source_manuscript_ids = restored.source_manuscript_ids
    document.derived_from = restored.derived_from
    document.blocks = restored.blocks
    document.revision += 1
    document.updated_at = utcnow()
    await db.save_document(document)
    await db.create_document_version(document, "Restored version")
    return document


@router.post("/documents/{document_id}/share-links", response_model=ShareLink, status_code=status.HTTP_201_CREATED, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def create_share_link(
    document_id: str,
    request: Request,
    payload: ShareLinkRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> ShareLink:
    require_client_header(request, ctx)
    await get_document(db, document_id, ctx.user_id)
    share_id = new_id("share")
    token = secrets.token_urlsafe(32)
    link = ShareLink(
        id=share_id,
        document_id=document_id,
        permission=payload.permission,
        url=f"https://app.example/share/{share_id}?token={token}",
        expires_at=payload.expires_at,
        created_at=utcnow(),
    )
    await db.save_share_link(ShareLinkRecord(link=link, token=token, document_id=document_id))
    return link


@router.get("/share/{share_id}", response_model=Document)
async def get_share_link(share_id: str, token: str, db: PostgresRepository = Depends(get_repository)) -> Document:
    record = await db.get_share_link_record(share_id)
    if not record or record.token != token:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Share link not found.")
    if record.link.expires_at <= utcnow():
        raise APIError(status.HTTP_403_FORBIDDEN, "forbidden", "Share link has expired.")
    document = await db.get_document(record.document_id)
    if not document:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Document not found.")
    return document.model_copy(update={"permission": record.link.permission})


@router.delete("/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def delete_document(
    document_id: str,
    request: Request,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> Response:
    require_client_header(request, ctx)
    document = await get_document(db, document_id, ctx.user_id)
    await db.delete_document(document.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/groups", response_model=GroupSummary, status_code=status.HTTP_201_CREATED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def create_group(
    request: Request,
    payload: GroupCreateRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_201_CREATED)
    name = payload.name.strip()
    if not name:
        raise validation_error("Group name must not be empty.")
    now = utcnow()
    group: GroupRecord | None = None
    for _ in range(MAX_INVITE_CODE_ATTEMPTS):
        candidate = GroupRecord(
            id=new_id("group"),
            name=name,
            invite_code=make_invite_code(),
            invite_code_expires_at=now + timedelta(seconds=GROUP_INVITE_CODE_SECONDS),
            created_by=ctx.user_id,
            created_at=now,
            updated_at=now,
        )
        if await db.create_group(candidate):
            group = candidate
            break
    if not group:
        raise APIError(status.HTTP_409_CONFLICT, "resource_conflict", "Could not allocate a unique invite code. Please retry.")
    summary = await db.get_group_summary_for_user(group.id, ctx.user_id)
    if not summary:
        raise APIError(status.HTTP_500_INTERNAL_SERVER_ERROR, "internal_error", "Created group membership is missing.")
    return await idempotent_json_response(db, idem, summary, status.HTTP_201_CREATED)


@router.post("/groups/join", response_model=GroupSummary, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def join_group(
    request: Request,
    payload: GroupJoinRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_200_OK)
    group = await db.get_group_record_by_invite_code(payload.invite_code)
    if not group:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Invite code not found.")
    summary = await db.get_group_summary_for_user(group.id, ctx.user_id)
    if summary:
        return await idempotent_json_response(db, idem, summary, status.HTTP_200_OK)
    if group.invite_code_expires_at <= utcnow():
        raise APIError(status.HTTP_403_FORBIDDEN, "forbidden", "Invite code has expired.")
    await db.add_group_member(group.id, ctx.user_id, "member", utcnow())
    summary = await db.get_group_summary_for_user(group.id, ctx.user_id)
    if not summary:
        raise APIError(status.HTTP_500_INTERNAL_SERVER_ERROR, "internal_error", "Joined group membership is missing.")
    return await idempotent_json_response(db, idem, summary, status.HTTP_200_OK)


@router.get("/groups", response_model=GroupListResponse)
async def list_groups(
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> GroupListResponse:
    groups = await db.list_groups_for_user(ctx.user_id)
    page, next_cursor = paginate(groups, limit, cursor)
    return GroupListResponse(items=page, next_cursor=next_cursor)


@router.get("/groups/{group_id}/messages", response_model=GroupMessageListResponse)
async def list_group_messages(
    group_id: str,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> GroupMessageListResponse:
    await require_group_member(db, group_id, ctx.user_id)
    messages = await db.list_group_document_messages(group_id)
    page, next_cursor = paginate(messages, limit, cursor)
    return GroupMessageListResponse(items=page, next_cursor=next_cursor)


@router.post("/groups/{group_id}/documents", response_model=GroupDocumentMessage, status_code=status.HTTP_201_CREATED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def send_document_to_group(
    group_id: str,
    request: Request,
    payload: GroupDocumentSendRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_201_CREATED)
    await require_group_member(db, group_id, ctx.user_id)
    document = await get_document(db, payload.document_id, ctx.user_id)
    now = utcnow()
    message = GroupDocumentMessage(
        id=new_id("gmsg"),
        group_id=group_id,
        sender_id=ctx.user_id,
        sender_name=ctx.user.name,
        document_id=document.id,
        document_title=document.title,
        document_revision=document.revision,
        sent_at=now,
    )
    await db.save_group_document_message(GroupDocumentMessageRecord(message=message, document_snapshot=document.model_copy(deep=True)))
    return await idempotent_json_response(db, idem, message, status.HTTP_201_CREATED)


@router.get("/groups/{group_id}/documents/{message_id}/download")
async def download_group_document(
    group_id: str,
    message_id: str,
    export_format: Annotated[Literal["pdf", "docx"], Query(alias="format")] = "docx",
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> Response:
    await require_group_member(db, group_id, ctx.user_id)
    record = await db.get_group_document_message_record(group_id, message_id)
    if not record:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Group document message not found.")
    content = render_export_content(record.document_snapshot, export_format)
    filename = f"{record.message.document_title}.{export_format}"
    content_type = "application/pdf" if export_format == "pdf" else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    return Response(
        content=content,
        media_type=content_type,
        headers={
            "Content-Length": str(len(content)),
            "Content-Disposition": attachment_disposition_filename(filename),
        },
    )


@router.post("/tasks/convert-manuscript", response_model=Task, status_code=status.HTTP_202_ACCEPTED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def convert_manuscript(
    request: Request,
    background_tasks: BackgroundTasks,
    payload: ConvertManuscriptRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    client_id = require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_202_ACCEPTED)
    manuscript = await get_manuscript(db, payload.manuscript_id, ctx.user_id)
    now = utcnow()
    task = Task(
        id=new_id("task"),
        type="convert_manuscript",
        status="queued",
        progress=TaskProgress(stage="queued", current=0, total=1, message="转换任务已创建"),
        result=None,
        error=None,
        retry_count=0,
        billing=None,
        created_at=now,
        updated_at=now,
    )
    await db.save_task(ctx.user_id, task, task_input=payload.model_dump(mode="json"))
    background_tasks.add_task(process_convert_task, db, ctx.user_id, task.id, manuscript.model_copy(deep=True), payload, get_vision_provider(request), get_text_provider(request))
    return await idempotent_json_response(db, idem, task, status.HTTP_202_ACCEPTED)


@router.post("/tasks/asr-audio", response_model=Task, status_code=status.HTTP_202_ACCEPTED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def asr_audio(
    request: Request,
    background_tasks: BackgroundTasks,
    payload: AsrAudioRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_202_ACCEPTED)
    asset_record = await get_asset_record(db, payload.asset_id, ctx.user_id)
    if asset_record.asset.kind != "audio" or asset_record.asset.status != "ready":
        raise validation_error("ASR requires a ready audio asset.")
    now = utcnow()
    task = Task(
        id=new_id("task"),
        type="asr_audio",
        status="queued",
        progress=TaskProgress(stage="queued", current=0, total=1, message="ASR task queued."),
        result=None,
        created_at=now,
        updated_at=now,
    )
    task_input = payload.model_dump(mode="json")
    await db.save_task(ctx.user_id, task, task_input=task_input)
    background_tasks.add_task(process_asr_task, db, ctx.user_id, task.id, payload, get_asr_provider(request))
    return await idempotent_json_response(db, idem, task, status.HTTP_202_ACCEPTED)


@router.post("/tasks/asr-audio/stream", dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def asr_audio_stream(
    request: Request,
    payload: AsrAudioRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> StreamingResponse:
    require_client_header(request, ctx, payload.client_id)
    require_idempotency_header(request)
    asset_record = await get_asset_record(db, payload.asset_id, ctx.user_id)
    if asset_record.asset.kind != "audio" or asset_record.asset.status != "ready":
        raise validation_error("ASR requires a ready audio asset.")
    now = utcnow()
    task = Task(
        id=new_id("task"),
        type="asr_audio",
        status="queued",
        progress=TaskProgress(stage="queued", current=0, total=1, message="ASR task queued."),
        result=None,
        created_at=now,
        updated_at=now,
    )
    await db.save_task(ctx.user_id, task, task_input=payload.model_dump(mode="json"))
    return StreamingResponse(
        stream_asr_task_events(db, ctx.user_id, task, payload, get_asr_provider(request)),
        media_type="text/event-stream",
    )


@router.post("/tasks/recognize-image", response_model=Task, status_code=status.HTTP_202_ACCEPTED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def recognize_image(
    request: Request,
    background_tasks: BackgroundTasks,
    payload: RecognizeImageRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_202_ACCEPTED)
    asset_record = await get_asset_record(db, payload.asset_id, ctx.user_id)
    if asset_record.asset.kind != "image" or asset_record.asset.status != "ready":
        raise validation_error("Image recognition requires a ready image asset.")
    now = utcnow()
    task = Task(
        id=new_id("task"),
        type="recognize_image",
        status="queued",
        progress=TaskProgress(stage="queued", current=0, total=1, message="Image recognition task queued."),
        result=None,
        created_at=now,
        updated_at=now,
    )
    await db.save_task(ctx.user_id, task, task_input=payload.model_dump(mode="json"))
    background_tasks.add_task(process_image_task, db, ctx.user_id, task.id, payload, get_vision_provider(request))
    return await idempotent_json_response(db, idem, task, status.HTTP_202_ACCEPTED)


@router.post("/tasks/recognize-image/stream", dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def recognize_image_stream(
    request: Request,
    payload: RecognizeImageRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> StreamingResponse:
    require_client_header(request, ctx, payload.client_id)
    require_idempotency_header(request)
    asset_record = await get_asset_record(db, payload.asset_id, ctx.user_id)
    if asset_record.asset.kind != "image" or asset_record.asset.status != "ready":
        raise validation_error("Image recognition requires a ready image asset.")
    now = utcnow()
    task = Task(
        id=new_id("task"),
        type="recognize_image",
        status="queued",
        progress=TaskProgress(stage="queued", current=0, total=1, message="Image recognition task queued."),
        result=None,
        created_at=now,
        updated_at=now,
    )
    await db.save_task(ctx.user_id, task, task_input=payload.model_dump(mode="json"))
    return StreamingResponse(
        stream_image_task_events(db, ctx.user_id, task, payload, get_vision_provider(request)),
        media_type="text/event-stream",
    )


@router.get("/tasks/{task_id}", response_model=Task)
async def get_task_route(task_id: str, ctx: AuthContext = Depends(auth_context), db: PostgresRepository = Depends(get_repository)) -> Task:
    return await get_task(db, task_id, ctx.user_id)


@router.post("/tasks/{task_id}/cancel", response_model=Task, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def cancel_task(
    task_id: str,
    request: Request,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    require_client_header(request, ctx)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_200_OK)
    task = await get_task(db, task_id, ctx.user_id)
    if task.status not in {"queued", "processing"}:
        raise APIError(status.HTTP_409_CONFLICT, "resource_conflict", "Only queued or processing tasks can be cancelled.")
    cancelled = task.model_copy(
        update={
            "status": "cancelled",
            "progress": TaskProgress(stage="completed", current=0, total=0, message="Task cancelled."),
            "billing": {"charged": False, "external_request_cancelled": True},
            "updated_at": utcnow(),
        }
    )
    await db.save_task(ctx.user_id, cancelled)
    return await idempotent_json_response(db, idem, cancelled, status.HTTP_200_OK)


@router.post("/exports", response_model=Task, status_code=status.HTTP_202_ACCEPTED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def create_export(
    request: Request,
    payload: ExportRequest,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> JSONResponse:
    require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return await idempotent_json_response(db, idem, None, status.HTTP_202_ACCEPTED)
    document = await get_document(db, payload.document_id, ctx.user_id)
    now = utcnow()
    export_id = new_id("export")
    asset_id = new_id("asset")
    filename = f"{document.id}.{payload.format}"
    content_type = "application/pdf" if payload.format == "pdf" else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    content = render_export_content(document, payload.format)
    checksum = hashlib.sha256(content).hexdigest()
    asset = Asset(
        id=asset_id,
        kind="export",
        filename=filename,
        content_type=content_type,
        size_bytes=len(content),
        checksum_sha256=checksum,
        status="ready",
        url=None,
        created_at=now,
        updated_at=now,
    )
    await db.save_asset(AssetRecord(owner_id=ctx.user_id, asset=asset, upload_id=new_id("upload"), part_size_bytes=1, uploaded_parts=[], content=content))
    export_record = ExportRecord(
        owner_id=ctx.user_id,
        export_id=export_id,
        asset_id=asset_id,
        document_id=document.id,
        document_revision=document.revision,
        format=payload.format,
        snapshot=document.model_copy(deep=True),
        created_at=now,
    )
    await db.save_export(export_record)
    task = Task(
        id=new_id("task"),
        type="export_document",
        status="succeeded",
        progress=TaskProgress(stage="completed", current=1, total=1, message="Export completed."),
        result={
            "export_id": export_id,
            "asset_id": asset_id,
            "document_id": document.id,
            "document_revision": document.revision,
            "format": payload.format,
        },
        created_at=now,
        updated_at=now,
    )
    await db.save_task(ctx.user_id, task)
    return await idempotent_json_response(db, idem, task, status.HTTP_202_ACCEPTED)


@router.get("/exports/{export_id}/download", response_model=ExportDownloadResponse)
async def download_export(
    export_id: str,
    request: Request,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> ExportDownloadResponse:
    record = await get_export_record(db, export_id, ctx.user_id)
    await get_document(db, record.document_id, ctx.user_id)
    return ExportDownloadResponse(
        download_url=make_asset_stream_url(request, record.asset_id),
        expires_at=utcnow() + timedelta(minutes=15),
    )


@router.post("/ai/agent/chat", dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def ai_agent_chat(
    request: Request,
    payload: AiChatRequest,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    ctx: AuthContext = Depends(auth_context),
    db: PostgresRepository = Depends(get_repository),
) -> StreamingResponse:
    require_client_header(request, ctx, payload.client_id)
    require_idempotency_header(request)
    await get_document(db, payload.document_id, ctx.user_id)
    resume_after = 0
    if last_event_id:
        try:
            resume_after = int(last_event_id)
        except ValueError:
            raise APIError(status.HTTP_400_BAD_REQUEST, "invalid_request", "Last-Event-ID must be an integer event id.")

    async def events():
        yield ": heartbeat\n\n"
        stream_events = [
            (1, "delta", '{"text":"AI service placeholder"}'),
            (2, "done", f'{{"message_id":"{new_id("msg")}","usage":{{"input_tokens":0,"output_tokens":0}}}}'),
        ]
        for event_id, event_name, data in stream_events:
            if event_id > resume_after:
                yield f"id: {event_id}\nevent: {event_name}\ndata: {data}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")


@router.websocket("/ai/handwriting/complete")
async def handwriting_complete(websocket: WebSocket, access_token: str, client_id: str, db: PostgresRepository = Depends(get_repository)) -> None:
    session = await db.get_token_session(access_token, "access")
    if not session or session.expires_at <= utcnow() or session.client_id != client_id:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        while True:
            message = await websocket.receive_json()
            await websocket.send_json(
                {
                    "type": "completion",
                    "block_id": message.get("block_id"),
                    "text": "",
                    "confidence": 0.0,
                    "latency_ms": 0,
                }
            )
    except WebSocketDisconnect:
        return


app.include_router(router)

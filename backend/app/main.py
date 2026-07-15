from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import math
import secrets
import uuid
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, Header, Query, Request, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from fastapi.routing import APIRouter
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.websockets import WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator
from starlette.exceptions import HTTPException as StarletteHTTPException


API_PREFIX = "/api/v1"
ACCESS_TOKEN_SECONDS = 30 * 60
REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60
IDEMPOTENCY_SECONDS = 24 * 60 * 60
MAX_LIMIT = 100
DEFAULT_LIMIT = 20
MAX_OPERATIONS = 100
MAX_BLOCK_BYTES = 256 * 1024
MAX_HANDWRITING_POINTS = 5000
MAX_CLIENT_TIME_SKEW_SECONDS = 24 * 60 * 60


Platform = Literal["ios", "android", "mac", "windows", "web"]
Permission = Literal["owner", "editor", "viewer"]
AssetKind = Literal["audio", "image", "export", "attachment"]
AssetStatus = Literal["pending_upload", "uploaded", "ready", "failed"]
TaskType = Literal["convert_manuscript", "asr_audio", "export_document", "ai_rewrite"]
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


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def make_token(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(32)}"


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


class AsrAudioRequest(StrictModel):
    asset_id: str
    language: str
    enable_diarization: bool
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
class AuthContext:
    user_id: str
    client_id: str
    user: User
    access_token: str


class Store:
    def __init__(self) -> None:
        self.users_by_id: dict[str, UserRecord] = {}
        self.user_id_by_email: dict[str, str] = {}
        self.devices_by_user: dict[str, dict[str, Device]] = {}
        self.access_tokens: dict[str, TokenSession] = {}
        self.refresh_tokens: dict[str, TokenSession] = {}
        self.idempotency: dict[tuple[str, str, str, str], IdempotencyRecord] = {}
        self.assets: dict[str, AssetRecord] = {}
        self.manuscripts: dict[str, Manuscript] = {}
        self.documents: dict[str, Document] = {}
        self.document_versions: dict[str, list[DocumentVersionRecord]] = {}
        self.tasks: dict[str, tuple[str, Task]] = {}
        self.exports: dict[str, ExportRecord] = {}
        self.share_links: dict[str, ShareLinkRecord] = {}

    def create_tokens(self, user_id: str, client_id: str) -> AuthResponse:
        user = self.users_by_id[user_id].user
        access_token = make_token("access")
        refresh_token = make_token("refresh")
        now = utcnow()
        self.access_tokens[access_token] = TokenSession(user_id, client_id, now + timedelta(seconds=ACCESS_TOKEN_SECONDS))
        self.refresh_tokens[refresh_token] = TokenSession(user_id, client_id, now + timedelta(seconds=REFRESH_TOKEN_SECONDS))
        return AuthResponse(
            access_token=access_token,
            access_token_expires_in=ACCESS_TOKEN_SECONDS,
            refresh_token=refresh_token,
            refresh_token_expires_in=REFRESH_TOKEN_SECONDS,
            user=user,
        )

    def upsert_device(self, user_id: str, device_input: DeviceInput) -> Device:
        now = utcnow()
        devices = self.devices_by_user.setdefault(user_id, {})
        existing = devices.get(device_input.client_id)
        created_at = existing.created_at if existing else now
        device = Device(
            id=device_input.client_id,
            platform=device_input.platform,
            app_version=device_input.app_version,
            name=device_input.name,
            last_seen_at=now,
            created_at=created_at,
        )
        devices[device.id] = device
        return device

    def touch_device(self, user_id: str, client_id: str) -> None:
        device = self.devices_by_user.get(user_id, {}).get(client_id)
        if device:
            self.devices_by_user[user_id][client_id] = device.model_copy(update={"last_seen_at": utcnow()})


store = Store()
bearer_scheme = HTTPBearer(auto_error=False)


def get_store() -> Store:
    return store


async def auth_context(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)] = None,
    db: Store = Depends(get_store),
) -> AuthContext:
    if not credentials or credentials.scheme.lower() != "bearer":
        raise APIError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Authorization bearer token is required.")
    token = credentials.credentials.strip()
    session = db.access_tokens.get(token)
    if not session or session.expires_at <= utcnow():
        raise APIError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Access token is missing, expired, or invalid.")
    user_record = db.users_by_id.get(session.user_id)
    if not user_record:
        raise APIError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Access token is missing, expired, or invalid.")
    db.touch_device(session.user_id, session.client_id)
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


async def require_idempotency(request: Request, ctx: AuthContext, db: Store) -> tuple[tuple[str, str, str, str], str, IdempotencyRecord | None]:
    key = request.headers.get("Idempotency-Key")
    if not key:
        raise validation_error("Idempotency-Key header is required for this write request.")
    body = await request.body()
    request_hash = hash_request_body(body)
    scope = (ctx.user_id, request.method.upper(), request.url.path, key)
    existing = db.idempotency.get(scope)
    if existing and existing.expires_at > utcnow():
        if existing.request_hash != request_hash:
            raise APIError(
                status.HTTP_409_CONFLICT,
                "idempotency_conflict",
                "Idempotency-Key was reused with a different request body.",
            )
        return scope, request_hash, existing
    return scope, request_hash, None


def idempotent_json_response(db: Store, idem: tuple[tuple[str, str, str, str], str, IdempotencyRecord | None], body: Any, status_code: int) -> JSONResponse:
    scope, request_hash, existing = idem
    if existing:
        return ContractJSONResponse(content=jsonable_encoder(existing.response_body), status_code=existing.status_code)
    db.idempotency[scope] = IdempotencyRecord(
        request_hash=request_hash,
        response_body=jsonable_encoder(body),
        status_code=status_code,
        expires_at=utcnow() + timedelta(seconds=IDEMPOTENCY_SECONDS),
    )
    return ContractJSONResponse(content=jsonable_encoder(body), status_code=status_code)


def make_error_response(request: Request, status_code: int, code: str, message: str, details: dict[str, Any] | None = None) -> JSONResponse:
    request_id = getattr(request.state, "request_id", new_id("req"))
    body = ErrorResponse(error=ErrorBody(code=code, message=message, details=details, request_id=request_id))
    return ContractJSONResponse(status_code=status_code, content=jsonable_encoder(body))


def assert_owner(user_id: str, owner_id: str) -> None:
    if user_id != owner_id:
        raise APIError(status.HTTP_403_FORBIDDEN, "forbidden", "You do not have access to this resource.")


def get_asset_record(db: Store, asset_id: str, user_id: str) -> AssetRecord:
    record = db.assets.get(asset_id)
    if not record:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Asset not found.")
    assert_owner(user_id, record.owner_id)
    return record


def get_manuscript(db: Store, manuscript_id: str, user_id: str) -> Manuscript:
    manuscript = db.manuscripts.get(manuscript_id)
    if not manuscript or manuscript.deleted:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Manuscript not found.")
    assert_owner(user_id, manuscript.owner_id)
    return manuscript


def get_document(db: Store, document_id: str, user_id: str) -> Document:
    document = db.documents.get(document_id)
    if not document:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Document not found.")
    assert_owner(user_id, document.owner_id)
    return document


def get_task(db: Store, task_id: str, user_id: str) -> Task:
    record = db.tasks.get(task_id)
    if not record:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Task not found.")
    owner_id, task = record
    assert_owner(user_id, owner_id)
    return task


def get_export_record(db: Store, export_id: str, user_id: str) -> ExportRecord:
    record = db.exports.get(export_id)
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


def ensure_asset_ready(db: Store, asset_id: str | None, owner_id: str) -> None:
    if not asset_id:
        return
    record = get_asset_record(db, asset_id, owner_id)
    if record.asset.status != "ready":
        raise validation_error("Block can only reference ready assets.", {"asset_id": asset_id, "status": record.asset.status})


def validate_block_asset_refs(db: Store, block: BaseBlock, owner_id: str) -> None:
    if isinstance(block, ManuscriptAudioBlock):
        ensure_asset_ready(db, block.props.asset_id, owner_id)
    elif isinstance(block, ManuscriptImageBlock):
        ensure_asset_ready(db, block.props.asset_id, owner_id)
    elif isinstance(block, ManuscriptHandwritingBlock):
        ensure_asset_ready(db, block.props.image_asset_id, owner_id)
    elif isinstance(block, DocumentImageBlock):
        ensure_asset_ready(db, block.props.asset_id, owner_id)


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


def apply_manuscript_operations(
    db: Store,
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
            validate_block_asset_refs(db, op.block, ctx.user_id)
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


def apply_document_operations(
    db: Store,
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
            validate_block_asset_refs(db, op.block, ctx.user_id)
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


def make_presigned_parts(asset_id: str, upload_id: str, content_type: str, part_size_bytes: int, size_bytes: int) -> list[UploadPart]:
    part_count = max(1, math.ceil(size_bytes / part_size_bytes))
    expires_at = utcnow() + timedelta(minutes=15)
    return [
        UploadPart(
            part_number=part_number,
            upload_url=f"https://object-storage.local/{asset_id}/{upload_id}/part-{part_number}",
            headers={"Content-Type": content_type},
            expires_at=expires_at,
        )
        for part_number in range(1, part_count + 1)
    ]


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


def device_platform(db: Store, user_id: str, client_id: str) -> Platform:
    return db.devices_by_user.get(user_id, {}).get(client_id, Device(id=client_id, platform="web", app_version="", name="", last_seen_at=utcnow(), created_at=utcnow())).platform


def source_ref(manuscript_id: str, block_id: str, time_range: SourceRange | None = None, region: SourceRegion | None = None) -> list[SourceRef]:
    return [SourceRef(manuscript_id=manuscript_id, block_id=block_id, range=time_range, region=region)]


def build_document_blocks_from_manuscript(db: Store, manuscript: Manuscript, task_id: str, client_id: str) -> list[DocumentBlock]:
    now = utcnow()
    platform = device_platform(db, manuscript.owner_id, client_id)
    blocks: list[DocumentBlock] = []
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
                    blocks.append(
                        DocumentParagraphBlock(
                            id=new_id("doc_block"),
                            type="paragraph",
                            props=TextProps(content=segment.text),
                            source_refs=source_ref(
                                manuscript.id,
                                source.id,
                                SourceRange(start_ms=segment.start_ms, end_ms=segment.end_ms),
                            ),
                            **base,
                        )
                    )
            elif source.props.transcript:
                blocks.append(
                    DocumentParagraphBlock(
                        id=new_id("doc_block"),
                        type="paragraph",
                        props=TextProps(content=source.props.transcript),
                        source_refs=source_ref(manuscript.id, source.id),
                        **base,
                    )
                )
        elif isinstance(source, ManuscriptHandwritingBlock) and source.props.ai_text:
            content = source.props.ai_text
            if len(content) <= 20:
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
            blocks.append(
                DocumentImageBlock(
                    id=new_id("doc_block"),
                    type="image",
                    props=source.props,
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
    return blocks


def create_document_version(db: Store, document: Document, title: str) -> None:
    version = DocumentVersion(
        id=new_id("ver"),
        document_id=document.id,
        revision=document.revision,
        title=title,
        created_by=document.owner_id,
        created_at=utcnow(),
    )
    db.document_versions.setdefault(document.id, []).append(DocumentVersionRecord(version=version, snapshot=document.model_copy(deep=True)))


def find_document_version(db: Store, document_id: str, version_id: str) -> DocumentVersionRecord | None:
    for record in db.document_versions.get(document_id, []):
        if record.version.id == version_id:
            return record
    return None


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


app = FastAPI(
    title="MeetingMate Backend",
    version="0.1.0",
    description="FastAPI/Pydantic API contract implementation for MeetingMate MVP.",
    openapi_version="3.1.0",
    default_response_class=ContractJSONResponse,
)
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


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/auth/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(payload: RegisterRequest, db: Store = Depends(get_store)) -> AuthResponse:
    email = str(payload.email).lower()
    if email in db.user_id_by_email:
        raise APIError(status.HTTP_409_CONFLICT, "resource_conflict", "Email is already registered.")
    now = utcnow()
    user = User(id=new_id("u"), email=payload.email, name=payload.name, avatar_url=None, created_at=now)
    db.users_by_id[user.id] = UserRecord(user=user, password_hash=password_hash(payload.password))
    db.user_id_by_email[email] = user.id
    db.upsert_device(user.id, payload.device)
    return db.create_tokens(user.id, payload.device.client_id)


@router.post("/auth/login", response_model=AuthResponse)
async def login(payload: LoginRequest, db: Store = Depends(get_store)) -> AuthResponse:
    email = str(payload.email).lower()
    user_id = db.user_id_by_email.get(email)
    if not user_id:
        raise APIError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Email or password is invalid.")
    user_record = db.users_by_id[user_id]
    if not verify_password(payload.password, user_record.password_hash):
        raise APIError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Email or password is invalid.")
    db.upsert_device(user_id, payload.device)
    return db.create_tokens(user_id, payload.device.client_id)


@router.post("/auth/refresh", response_model=AuthResponse)
async def refresh_token(payload: RefreshRequest, db: Store = Depends(get_store)) -> AuthResponse:
    session = db.refresh_tokens.get(payload.refresh_token)
    if not session or session.expires_at <= utcnow() or session.client_id != payload.client_id:
        raise APIError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Refresh token is missing, expired, or invalid.")
    del db.refresh_tokens[payload.refresh_token]
    db.touch_device(session.user_id, session.client_id)
    return db.create_tokens(session.user_id, session.client_id)


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def logout(
    request: Request,
    payload: LogoutRequest,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> Response:
    require_client_header(request, ctx, payload.client_id)
    session = db.refresh_tokens.get(payload.refresh_token)
    if session and session.user_id == ctx.user_id and session.client_id == payload.client_id:
        del db.refresh_tokens[payload.refresh_token]
    for token, active_session in list(db.access_tokens.items()):
        if active_session.user_id == ctx.user_id and active_session.client_id == payload.client_id:
            del db.access_tokens[token]
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/devices", response_model=DeviceListResponse)
async def list_devices(
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> DeviceListResponse:
    devices = sorted(db.devices_by_user.get(ctx.user_id, {}).values(), key=lambda item: (item.last_seen_at, item.id), reverse=True)
    page, next_cursor = paginate(list(devices), limit, cursor)
    return DeviceListResponse(items=page, next_cursor=next_cursor)


@router.delete("/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def revoke_device(
    device_id: str,
    request: Request,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> Response:
    require_client_header(request, ctx)
    devices = db.devices_by_user.get(ctx.user_id, {})
    if device_id not in devices:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Device not found.")
    del devices[device_id]
    for token, session in list(db.access_tokens.items()):
        if session.user_id == ctx.user_id and session.client_id == device_id:
            del db.access_tokens[token]
    for token, session in list(db.refresh_tokens.items()):
        if session.user_id == ctx.user_id and session.client_id == device_id:
            del db.refresh_tokens[token]
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/assets/upload", response_model=AssetUploadResponse, status_code=status.HTTP_201_CREATED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def create_asset_upload(
    request: Request,
    payload: AssetUploadRequest,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> JSONResponse:
    require_client_header(request, ctx)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return idempotent_json_response(db, idem, None, status.HTTP_201_CREATED)
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
    db.assets[asset_id] = AssetRecord(owner_id=ctx.user_id, asset=asset, upload_id=upload_id, part_size_bytes=payload.part_size_bytes, uploaded_parts=[])
    response = AssetUploadResponse(
        asset_id=asset_id,
        upload_id=upload_id,
        part_size_bytes=payload.part_size_bytes,
        parts=make_presigned_parts(asset_id, upload_id, payload.content_type, payload.part_size_bytes, payload.size_bytes),
    )
    return idempotent_json_response(db, idem, response, status.HTTP_201_CREATED)


@router.get("/assets/{asset_id}/upload-parts", response_model=AssetUploadPartsResponse)
async def get_asset_upload_parts(
    asset_id: str,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> AssetUploadPartsResponse:
    record = get_asset_record(db, asset_id, ctx.user_id)
    all_parts = make_presigned_parts(record.asset.id, record.upload_id, record.asset.content_type, record.part_size_bytes, record.asset.size_bytes)
    uploaded_numbers = {part.part_number for part in record.uploaded_parts}
    missing = [part for part in all_parts if part.part_number not in uploaded_numbers]
    return AssetUploadPartsResponse(
        asset_id=asset_id,
        upload_id=record.upload_id,
        part_size_bytes=record.part_size_bytes,
        uploaded_parts=record.uploaded_parts,
        missing_parts=missing,
    )


@router.post("/assets/{asset_id}/complete", response_model=Asset, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def complete_asset_upload(
    asset_id: str,
    request: Request,
    payload: AssetCompleteRequest,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> JSONResponse:
    require_client_header(request, ctx)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return idempotent_json_response(db, idem, None, status.HTTP_200_OK)
    record = get_asset_record(db, asset_id, ctx.user_id)
    if payload.upload_id != record.upload_id:
        record.asset = record.asset.model_copy(update={"status": "failed", "updated_at": utcnow()})
        raise validation_error("upload_id does not match asset upload.")
    if payload.size_bytes != record.asset.size_bytes or payload.checksum_sha256 != record.asset.checksum_sha256:
        record.asset = record.asset.model_copy(update={"status": "failed", "updated_at": utcnow()})
        raise validation_error("size_bytes or checksum_sha256 does not match the upload request.")
    try:
        validate_complete_parts(payload)
    except APIError:
        record.asset = record.asset.model_copy(update={"status": "failed", "updated_at": utcnow()})
        raise
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
    return idempotent_json_response(db, idem, record.asset, status.HTTP_200_OK)


@router.get("/assets/{asset_id}", response_model=Asset)
async def get_asset(asset_id: str, ctx: AuthContext = Depends(auth_context), db: Store = Depends(get_store)) -> Asset:
    record = get_asset_record(db, asset_id, ctx.user_id)
    return record.asset.model_copy(update={"url": None})


@router.get("/assets/{asset_id}/stream", status_code=status.HTTP_302_FOUND)
async def stream_asset(asset_id: str, ctx: AuthContext = Depends(auth_context), db: Store = Depends(get_store)) -> RedirectResponse:
    record = get_asset_record(db, asset_id, ctx.user_id)
    return RedirectResponse(url=f"https://object-storage.local/{record.asset.id}/download?expires_in=600", status_code=status.HTTP_302_FOUND)


@router.delete("/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def delete_asset(
    asset_id: str,
    request: Request,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> Response:
    require_client_header(request, ctx)
    record = get_asset_record(db, asset_id, ctx.user_id)
    for manuscript in db.manuscripts.values():
        if manuscript.owner_id == ctx.user_id:
            for block in manuscript.blocks:
                if isinstance(block, (ManuscriptAudioBlock, ManuscriptImageBlock)) and block.props.asset_id == asset_id:
                    raise APIError(status.HTTP_409_CONFLICT, "resource_conflict", "Asset is still referenced.", {"reason": "still_referenced"})
                if isinstance(block, ManuscriptHandwritingBlock) and block.props.image_asset_id == asset_id:
                    raise APIError(status.HTTP_409_CONFLICT, "resource_conflict", "Asset is still referenced.", {"reason": "still_referenced"})
    for document in db.documents.values():
        if document.owner_id == ctx.user_id:
            for block in document.blocks:
                if isinstance(block, DocumentImageBlock) and block.props.asset_id == asset_id:
                    raise APIError(status.HTTP_409_CONFLICT, "resource_conflict", "Asset is still referenced.", {"reason": "still_referenced"})
    del db.assets[record.asset.id]
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/manuscripts", response_model=ManuscriptListResponse)
async def list_manuscripts(
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> ManuscriptListResponse:
    manuscripts = [item for item in db.manuscripts.values() if item.owner_id == ctx.user_id and not item.deleted]
    manuscripts.sort(key=lambda item: (item.updated_at, item.id), reverse=True)
    summaries = [manuscript_summary(item) for item in manuscripts]
    page, next_cursor = paginate(summaries, limit, cursor)
    return ManuscriptListResponse(items=page, next_cursor=next_cursor)


@router.post("/manuscripts", response_model=Manuscript, status_code=status.HTTP_201_CREATED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def create_manuscript(
    request: Request,
    payload: ManuscriptCreateRequest,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> JSONResponse:
    client_id = require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return idempotent_json_response(db, idem, None, status.HTTP_201_CREATED)
    now = utcnow()
    blocks: list[ManuscriptBlock] = []
    for block in payload.initial_blocks:
        validate_block_author_and_client(block, ctx, client_id)
        validate_block_payload(block)
        validate_block_asset_refs(db, block, ctx.user_id)
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
    db.manuscripts[manuscript.id] = manuscript
    return idempotent_json_response(db, idem, manuscript, status.HTTP_201_CREATED)


@router.get("/manuscripts/{manuscript_id}", response_model=Manuscript)
async def get_manuscript_route(manuscript_id: str, ctx: AuthContext = Depends(auth_context), db: Store = Depends(get_store)) -> Manuscript:
    return get_manuscript(db, manuscript_id, ctx.user_id)


@router.get("/manuscripts/{manuscript_id}/blocks", response_model=ManuscriptBlockListResponse)
async def list_manuscript_blocks(
    manuscript_id: str,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = MAX_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> ManuscriptBlockListResponse:
    manuscript = get_manuscript(db, manuscript_id, ctx.user_id)
    page, next_cursor = paginate(manuscript.blocks, limit, cursor)
    return ManuscriptBlockListResponse(items=page, next_cursor=next_cursor, revision=manuscript.revision)


@router.put("/manuscripts/{manuscript_id}/blocks", response_model=ManuscriptSyncResponse, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def sync_manuscript_blocks(
    manuscript_id: str,
    request: Request,
    payload: ManuscriptSyncRequest,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> JSONResponse:
    client_id = require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return idempotent_json_response(db, idem, None, status.HTTP_200_OK)
    manuscript = get_manuscript(db, manuscript_id, ctx.user_id)
    if payload.base_revision != manuscript.revision:
        raise APIError(
            status.HTTP_409_CONFLICT,
            "revision_conflict",
            "Manuscript revision is outdated.",
            {"server_revision": manuscript.revision, "client_revision": payload.base_revision, "latest_blocks": [dump_model(block) for block in manuscript.blocks]},
        )
    changed, applied = apply_manuscript_operations(db, manuscript, payload, ctx, client_id)
    response = ManuscriptSyncResponse(resource_id=manuscript.id, revision=manuscript.revision, applied_op_ids=applied, conflicts=[], blocks=changed)
    return idempotent_json_response(db, idem, response, status.HTTP_200_OK)


@router.delete("/manuscripts/{manuscript_id}", response_model=DeletedManuscriptResponse, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def delete_manuscript(
    manuscript_id: str,
    request: Request,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> DeletedManuscriptResponse:
    require_client_header(request, ctx)
    manuscript = get_manuscript(db, manuscript_id, ctx.user_id)
    now = utcnow()
    manuscript.deleted = True
    manuscript.deleted_at = now
    manuscript.updated_at = now
    manuscript.revision += 1
    return DeletedManuscriptResponse(id=manuscript.id, deleted=True, deleted_at=now)


@router.get("/documents", response_model=DocumentListResponse)
async def list_documents(
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> DocumentListResponse:
    documents = [item for item in db.documents.values() if item.owner_id == ctx.user_id]
    documents.sort(key=lambda item: (item.updated_at, item.id), reverse=True)
    summaries = [document_summary(item) for item in documents]
    page, next_cursor = paginate(summaries, limit, cursor)
    return DocumentListResponse(items=page, next_cursor=next_cursor)


@router.post("/documents", response_model=Document, status_code=status.HTTP_201_CREATED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def create_document(
    request: Request,
    payload: DocumentCreateRequest,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> JSONResponse:
    client_id = require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return idempotent_json_response(db, idem, None, status.HTTP_201_CREATED)
    if payload.derived_from is not None:
        raise validation_error("derived_from is server-managed and must be null for manual document creation.")
    now = utcnow()
    for manuscript_id in payload.source_manuscript_ids:
        get_manuscript(db, manuscript_id, ctx.user_id)
    blocks: list[DocumentBlock] = []
    for block in payload.initial_blocks:
        validate_block_author_and_client(block, ctx, client_id)
        validate_block_payload(block)
        validate_block_asset_refs(db, block, ctx.user_id)
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
    db.documents[document.id] = document
    create_document_version(db, document, "Initial version")
    return idempotent_json_response(db, idem, document, status.HTTP_201_CREATED)


@router.get("/documents/{document_id}", response_model=Document)
async def get_document_route(document_id: str, ctx: AuthContext = Depends(auth_context), db: Store = Depends(get_store)) -> Document:
    return get_document(db, document_id, ctx.user_id)


@router.get("/documents/{document_id}/blocks", response_model=DocumentBlockListResponse)
async def list_document_blocks(
    document_id: str,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = MAX_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> DocumentBlockListResponse:
    document = get_document(db, document_id, ctx.user_id)
    page, next_cursor = paginate(document.blocks, limit, cursor)
    return DocumentBlockListResponse(items=page, next_cursor=next_cursor, revision=document.revision)


@router.put("/documents/{document_id}/blocks", response_model=DocumentSyncResponse, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def sync_document_blocks(
    document_id: str,
    request: Request,
    payload: DocumentSyncRequest,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> JSONResponse:
    client_id = require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return idempotent_json_response(db, idem, None, status.HTTP_200_OK)
    document = get_document(db, document_id, ctx.user_id)
    if payload.base_revision != document.revision:
        raise APIError(
            status.HTTP_409_CONFLICT,
            "revision_conflict",
            "Document revision is outdated.",
            {"server_revision": document.revision, "client_revision": payload.base_revision, "latest_blocks": [dump_model(block) for block in document.blocks]},
        )
    changed, applied = apply_document_operations(db, document, payload, ctx, client_id)
    create_document_version(db, document, "Automatic version")
    response = DocumentSyncResponse(resource_id=document.id, revision=document.revision, applied_op_ids=applied, conflicts=[], blocks=changed)
    return idempotent_json_response(db, idem, response, status.HTTP_200_OK)


@router.get("/documents/{document_id}/versions", response_model=DocumentVersionListResponse)
async def list_document_versions(
    document_id: str,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: str | None = None,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> DocumentVersionListResponse:
    get_document(db, document_id, ctx.user_id)
    versions = sorted((record.version for record in db.document_versions.get(document_id, [])), key=lambda item: (item.created_at, item.id), reverse=True)
    page, next_cursor = paginate(versions, limit, cursor)
    return DocumentVersionListResponse(items=page, next_cursor=next_cursor)


@router.post("/documents/{document_id}/versions/{version_id}/restore", response_model=Document, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def restore_document_version(
    document_id: str,
    version_id: str,
    request: Request,
    payload: RestoreVersionRequest,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> Document:
    require_client_header(request, ctx, payload.client_id)
    document = get_document(db, document_id, ctx.user_id)
    if payload.base_revision != document.revision:
        raise APIError(status.HTTP_409_CONFLICT, "revision_conflict", "Document revision is outdated.", {"server_revision": document.revision, "client_revision": payload.base_revision})
    version_record = find_document_version(db, document_id, version_id)
    if not version_record:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Document version not found.")
    restored = version_record.snapshot.model_copy(deep=True)
    document.title = restored.title
    document.source_manuscript_ids = restored.source_manuscript_ids
    document.derived_from = restored.derived_from
    document.blocks = restored.blocks
    document.revision += 1
    document.updated_at = utcnow()
    create_document_version(db, document, "Restored version")
    return document


@router.post("/documents/{document_id}/share-links", response_model=ShareLink, status_code=status.HTTP_201_CREATED, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def create_share_link(
    document_id: str,
    request: Request,
    payload: ShareLinkRequest,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> ShareLink:
    require_client_header(request, ctx)
    get_document(db, document_id, ctx.user_id)
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
    db.share_links[share_id] = ShareLinkRecord(link=link, token=token, document_id=document_id)
    return link


@router.get("/share/{share_id}", response_model=Document)
async def get_share_link(share_id: str, token: str, db: Store = Depends(get_store)) -> Document:
    record = db.share_links.get(share_id)
    if not record or record.token != token:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Share link not found.")
    if record.link.expires_at <= utcnow():
        raise APIError(status.HTTP_403_FORBIDDEN, "forbidden", "Share link has expired.")
    document = db.documents.get(record.document_id)
    if not document:
        raise APIError(status.HTTP_404_NOT_FOUND, "not_found", "Document not found.")
    return document.model_copy(update={"permission": record.link.permission})


@router.delete("/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=CLIENT_HEADER_DEPENDENCIES)
async def delete_document(
    document_id: str,
    request: Request,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> Response:
    require_client_header(request, ctx)
    document = get_document(db, document_id, ctx.user_id)
    del db.documents[document.id]
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/tasks/convert-manuscript", response_model=Task, status_code=status.HTTP_202_ACCEPTED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def convert_manuscript(
    request: Request,
    payload: ConvertManuscriptRequest,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> JSONResponse:
    client_id = require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return idempotent_json_response(db, idem, None, status.HTTP_202_ACCEPTED)
    manuscript = get_manuscript(db, payload.manuscript_id, ctx.user_id)
    now = utcnow()
    task_id = new_id("task")
    blocks = build_document_blocks_from_manuscript(db, manuscript, task_id, client_id)
    derived_from = DerivedFrom(manuscript_id=manuscript.id, task_id=task_id, mode=payload.mode, converted_at=now)
    document = Document(
        id=new_id("doc"),
        title=payload.title,
        owner_id=ctx.user_id,
        source_manuscript_ids=[manuscript.id],
        derived_from=derived_from,
        revision=1,
        blocks=blocks,
        permission="owner",
        created_at=now,
        updated_at=now,
    )
    db.documents[document.id] = document
    create_document_version(db, document, "Converted from manuscript")
    task = Task(
        id=task_id,
        type="convert_manuscript",
        status="succeeded",
        progress=TaskProgress(stage="completed", current=1, total=1, message="Conversion completed."),
        result={"document_id": document.id},
        error=None,
        retry_count=0,
        billing=None,
        created_at=now,
        updated_at=now,
    )
    db.tasks[task.id] = (ctx.user_id, task)
    return idempotent_json_response(db, idem, task, status.HTTP_202_ACCEPTED)


@router.post("/tasks/asr-audio", response_model=Task, status_code=status.HTTP_202_ACCEPTED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def asr_audio(
    request: Request,
    payload: AsrAudioRequest,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> JSONResponse:
    require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return idempotent_json_response(db, idem, None, status.HTTP_202_ACCEPTED)
    asset_record = get_asset_record(db, payload.asset_id, ctx.user_id)
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
    db.tasks[task.id] = (ctx.user_id, task)
    return idempotent_json_response(db, idem, task, status.HTTP_202_ACCEPTED)


@router.get("/tasks/{task_id}", response_model=Task)
async def get_task_route(task_id: str, ctx: AuthContext = Depends(auth_context), db: Store = Depends(get_store)) -> Task:
    return get_task(db, task_id, ctx.user_id)


@router.post("/tasks/{task_id}/cancel", response_model=Task, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def cancel_task(
    task_id: str,
    request: Request,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> JSONResponse:
    require_client_header(request, ctx)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return idempotent_json_response(db, idem, None, status.HTTP_200_OK)
    task = get_task(db, task_id, ctx.user_id)
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
    db.tasks[task_id] = (ctx.user_id, cancelled)
    return idempotent_json_response(db, idem, cancelled, status.HTTP_200_OK)


@router.post("/exports", response_model=Task, status_code=status.HTTP_202_ACCEPTED, dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def create_export(
    request: Request,
    payload: ExportRequest,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> JSONResponse:
    require_client_header(request, ctx, payload.client_id)
    idem = await require_idempotency(request, ctx, db)
    if idem[2]:
        return idempotent_json_response(db, idem, None, status.HTTP_202_ACCEPTED)
    document = get_document(db, payload.document_id, ctx.user_id)
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
    db.assets[asset_id] = AssetRecord(owner_id=ctx.user_id, asset=asset, upload_id=new_id("upload"), part_size_bytes=1, uploaded_parts=[], content=content)
    db.exports[export_id] = ExportRecord(
        owner_id=ctx.user_id,
        export_id=export_id,
        asset_id=asset_id,
        document_id=document.id,
        document_revision=document.revision,
        format=payload.format,
        snapshot=document.model_copy(deep=True),
        created_at=now,
    )
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
    db.tasks[task.id] = (ctx.user_id, task)
    return idempotent_json_response(db, idem, task, status.HTTP_202_ACCEPTED)


@router.get("/exports/{export_id}/download", response_model=ExportDownloadResponse)
async def download_export(export_id: str, ctx: AuthContext = Depends(auth_context), db: Store = Depends(get_store)) -> ExportDownloadResponse:
    record = get_export_record(db, export_id, ctx.user_id)
    get_document(db, record.document_id, ctx.user_id)
    return ExportDownloadResponse(
        download_url=f"https://object-storage.local/{record.asset_id}/download?expires_in=600",
        expires_at=utcnow() + timedelta(minutes=15),
    )


@router.post("/ai/agent/chat", dependencies=IDEMPOTENT_WRITE_DEPENDENCIES)
async def ai_agent_chat(
    request: Request,
    payload: AiChatRequest,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    ctx: AuthContext = Depends(auth_context),
    db: Store = Depends(get_store),
) -> StreamingResponse:
    require_client_header(request, ctx, payload.client_id)
    require_idempotency_header(request)
    get_document(db, payload.document_id, ctx.user_id)
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
async def handwriting_complete(websocket: WebSocket, access_token: str, client_id: str, db: Store = Depends(get_store)) -> None:
    session = db.access_tokens.get(access_token)
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

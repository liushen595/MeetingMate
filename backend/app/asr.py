from __future__ import annotations

import asyncio
import base64
import json
import os
import queue
from dataclasses import dataclass
from typing import Any, AsyncIterator

import httpx


DASHSCOPE_MAX_BASE64_BYTES = 10 * 1024 * 1024


@dataclass(frozen=True)
class AsrSegment:
    speaker_id: str
    start_ms: int
    end_ms: int
    text: str
    confidence: float


@dataclass(frozen=True)
class AsrResult:
    transcript: str
    speaker_segments: list[AsrSegment]


class AsrProviderError(Exception):
    def __init__(self, message: str, retryable: bool = True) -> None:
        self.message = message
        self.retryable = retryable


class AsrProvider:
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
        transcript = ""
        async for delta in self.stream_transcribe(
            filename=filename,
            content_type=content_type,
            content=content,
            duration_ms=duration_ms,
            language=language,
            enable_diarization=enable_diarization,
        ):
            transcript = append_stream_text(transcript, delta)
        return result_from_text(transcript, duration_ms, enable_diarization)

    async def stream_transcribe(
        self,
        *,
        filename: str,
        content_type: str,
        content: bytes,
        duration_ms: int | None,
        language: str,
        enable_diarization: bool,
    ) -> AsyncIterator[str]:
        result = await self.transcribe(
            filename=filename,
            content_type=content_type,
            content=content,
            duration_ms=duration_ms,
            language=language,
            enable_diarization=enable_diarization,
        )
        if result.transcript:
            yield result.transcript


def append_stream_text(current: str, chunk: str) -> str:
    if not chunk:
        return current
    if chunk.startswith(current):
        return chunk
    return current + chunk


def stream_delta(current: str, chunk: str) -> tuple[str, str]:
    if not chunk:
        return current, ""
    if chunk.startswith(current):
        return chunk, chunk[len(current) :]
    return current + chunk, chunk


def result_from_text(text: str, duration_ms: int | None, enable_diarization: bool) -> AsrResult:
    transcript = text.strip()
    segments: list[AsrSegment] = []
    if transcript and enable_diarization:
        segments.append(
            AsrSegment(
                speaker_id="speaker_1",
                start_ms=0,
                end_ms=max(duration_ms or 0, 1),
                text=transcript,
                confidence=1.0,
            )
        )
    return AsrResult(transcript=transcript, speaker_segments=segments)


def dashscope_language(language: str) -> str | None:
    value = language.strip().lower()
    if not value:
        return None
    if value.startswith("zh"):
        return "zh"
    if value.startswith("en"):
        return "en"
    if value.startswith("ja"):
        return "ja"
    if value.startswith("ko"):
        return "ko"
    return value.split("-", 1)[0]


def object_get(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def extract_dashscope_text(response: Any) -> str | None:
    output = object_get(response, "output")
    choices = object_get(output, "choices") if output is not None else None
    if not choices:
        return None
    message = object_get(choices[0], "message")
    content = object_get(message, "content") if message is not None else None
    if not content:
        return None
    first = content[0]
    text = object_get(first, "text")
    return str(text) if text is not None else None


class DashscopeAsrProvider(AsrProvider):
    def __init__(self, *, api_url: str, api_key: str, model: str = "qwen3-asr-flash") -> None:
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    async def stream_transcribe(
        self,
        *,
        filename: str,
        content_type: str,
        content: bytes,
        duration_ms: int | None,
        language: str,
        enable_diarization: bool,
    ) -> AsyncIterator[str]:
        if not self.api_key:
            raise AsrProviderError("DASHSCOPE_API_KEY is not configured.", retryable=False)
        if not self.api_url:
            raise AsrProviderError("DASHSCOPE_API_URL is not configured.", retryable=False)
        encoded = base64.b64encode(content)
        if len(encoded) > DASHSCOPE_MAX_BASE64_BYTES:
            raise AsrProviderError("DashScope ASR input exceeds the 10MB base64 limit.", retryable=False)

        try:
            import dashscope
        except ModuleNotFoundError as exc:
            raise AsrProviderError("dashscope SDK is not installed.", retryable=False) from exc

        dashscope.base_http_api_url = self.api_url
        data_uri = f"data:{content_type};base64,{encoded.decode('ascii')}"
        asr_options: dict[str, Any] = {"enable_itn": False}
        mapped_language = dashscope_language(language)
        if mapped_language:
            asr_options["language"] = mapped_language
        messages = [{"role": "user", "content": [{"audio": data_uri}]}]
        result_queue: queue.Queue[str | BaseException | None] = queue.Queue()

        def worker() -> None:
            try:
                responses = dashscope.MultiModalConversation.call(
                    api_key=self.api_key,
                    model=self.model,
                    messages=messages,
                    result_format="message",
                    asr_options=asr_options,
                    stream=True,
                )
                for response in responses:
                    text = extract_dashscope_text(response)
                    if text:
                        result_queue.put(text)
                result_queue.put(None)
            except BaseException as exc:
                result_queue.put(exc)

        thread = asyncio.to_thread(worker)
        worker_task = asyncio.create_task(thread)
        try:
            while True:
                item = await asyncio.to_thread(result_queue.get)
                if item is None:
                    break
                if isinstance(item, BaseException):
                    raise AsrProviderError(str(item), retryable=True) from item
                yield item
        finally:
            await worker_task


class AzureFastTranscriptionProvider(AsrProvider):
    def __init__(self, *, endpoint: str, api_key: str, api_version: str = "2025-10-15") -> None:
        self.endpoint = endpoint.rstrip("/")
        self.api_key = api_key
        self.api_version = api_version

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
        if not self.endpoint or not self.api_key:
            raise AsrProviderError("Azure Speech endpoint or key is not configured.", retryable=False)
        definition: dict[str, Any] = {"locales": [language] if language else []}
        if enable_diarization:
            definition["diarization"] = {"enabled": True}
        async with httpx.AsyncClient(timeout=600) as client:
            response = await client.post(
                f"{self.endpoint}/speechtotext/transcriptions:transcribe",
                params={"api-version": self.api_version},
                headers={"Ocp-Apim-Subscription-Key": self.api_key},
                files={
                    "audio": (filename, content, content_type),
                    "definition": (None, json.dumps(definition), "application/json"),
                },
            )
        if response.status_code >= 500 or response.status_code == 429:
            raise AsrProviderError("Azure Speech service is temporarily unavailable.", retryable=True)
        if response.status_code >= 400:
            raise AsrProviderError(f"Azure Speech rejected the ASR request: {response.text}", retryable=False)
        return azure_result_from_response(response.json())


def azure_result_from_response(payload: dict[str, Any]) -> AsrResult:
    combined = payload.get("combinedPhrases") or []
    transcript = " ".join(str(item.get("text", "")).strip() for item in combined if item.get("text")).strip()
    phrases = payload.get("phrases") or []
    segments: list[AsrSegment] = []
    for phrase in phrases:
        text = str(phrase.get("text", "")).strip()
        if not text:
            continue
        start_ms = int(phrase.get("offsetMilliseconds") or 0)
        duration_ms = int(phrase.get("durationMilliseconds") or 0)
        speaker = phrase.get("speaker")
        segments.append(
            AsrSegment(
                speaker_id=f"speaker_{speaker}" if speaker is not None else "speaker_1",
                start_ms=start_ms,
                end_ms=start_ms + duration_ms,
                text=text,
                confidence=float(phrase.get("confidence") or 1.0),
            )
        )
    if not transcript:
        transcript = " ".join(segment.text for segment in segments).strip()
    return AsrResult(transcript=transcript, speaker_segments=segments)


def provider_from_environment(provider_name: str) -> AsrProvider:
    provider = provider_name.strip().lower()
    if provider == "dashscope":
        return DashscopeAsrProvider(
            api_url=os.getenv("DASHSCOPE_API_URL", "").strip(),
            api_key=os.getenv("DASHSCOPE_API_KEY", "").strip(),
            model=os.getenv("DASHSCOPE_ASR_MODEL", "qwen3-asr-flash").strip() or "qwen3-asr-flash",
        )
    if provider == "azure":
        return AzureFastTranscriptionProvider(
            endpoint=os.getenv("AZURE_SPEECH_ENDPOINT", "").strip(),
            api_key=os.getenv("AZURE_SPEECH_KEY", "").strip(),
            api_version=os.getenv("AZURE_SPEECH_API_VERSION", "2025-10-15").strip() or "2025-10-15",
        )
    raise AsrProviderError(f"Unsupported ASR_PROVIDER: {provider_name}", retryable=False)

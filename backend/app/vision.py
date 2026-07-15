from __future__ import annotations

import asyncio
import base64
import os
import queue
from dataclasses import dataclass
from typing import Any, AsyncIterator


DASHSCOPE_MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024


@dataclass(frozen=True)
class VisionResult:
    caption: str
    text: str


class VisionProviderError(Exception):
    def __init__(self, message: str, retryable: bool = True) -> None:
        self.message = message
        self.retryable = retryable


class VisionProvider:
    async def recognize(
        self,
        *,
        filename: str,
        content_type: str,
        content: bytes,
        width: int | None,
        height: int | None,
        language: str,
    ) -> VisionResult:
        text = ""
        async for chunk in self.stream_recognize(
            filename=filename,
            content_type=content_type,
            content=content,
            width=width,
            height=height,
            language=language,
        ):
            text = append_stream_text(text, chunk)
        return result_from_text(text)

    async def stream_recognize(
        self,
        *,
        filename: str,
        content_type: str,
        content: bytes,
        width: int | None,
        height: int | None,
        language: str,
    ) -> AsyncIterator[str]:
        result = await self.recognize(
            filename=filename,
            content_type=content_type,
            content=content,
            width=width,
            height=height,
            language=language,
        )
        if result.text:
            yield result.text


def append_stream_text(current: str, chunk: str) -> str:
    if not chunk:
        return current
    if chunk.startswith(current):
        return chunk
    return current + chunk


def first_nonempty_line(text: str) -> str:
    for line in text.splitlines():
        value = line.strip()
        if value:
            return value[:120]
    return ""


def result_from_text(text: str) -> VisionResult:
    normalized = text.strip()
    return VisionResult(caption=first_nonempty_line(normalized), text=normalized)


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


class DashscopeVisionProvider(VisionProvider):
    def __init__(self, *, api_url: str, api_key: str, model: str) -> None:
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    async def stream_recognize(
        self,
        *,
        filename: str,
        content_type: str,
        content: bytes,
        width: int | None,
        height: int | None,
        language: str,
    ) -> AsyncIterator[str]:
        if not self.api_key:
            raise VisionProviderError("DASHSCOPE_API_KEY is not configured.", retryable=False)
        if not self.api_url:
            raise VisionProviderError("DASHSCOPE_API_URL is not configured.", retryable=False)
        encoded = base64.b64encode(content)
        if len(encoded) > DASHSCOPE_MAX_IMAGE_BASE64_BYTES:
            raise VisionProviderError("DashScope image input exceeds the 10MB base64 limit.", retryable=False)

        try:
            import dashscope
        except ModuleNotFoundError as exc:
            raise VisionProviderError("dashscope SDK is not installed.", retryable=False) from exc

        dashscope.base_http_api_url = self.api_url
        data_uri = f"data:{content_type};base64,{encoded.decode('ascii')}"
        prompt = (
            "请识别这张图片，使用中文输出。第一行给出一句简洁图片说明；"
            "随后提取图片中的可读文字、白板要点、图表关系和待办事项。"
        )
        if language:
            prompt += f" 用户语言偏好：{language}。"
        if width and height:
            prompt += f" 图片尺寸：{width}x{height}。"
        messages = [{"role": "user", "content": [{"image": data_uri}, {"text": prompt}]}]
        result_queue: queue.Queue[str | BaseException | None] = queue.Queue()

        def worker() -> None:
            try:
                responses = dashscope.MultiModalConversation.call(
                    api_key=self.api_key,
                    model=self.model,
                    messages=messages,
                    result_format="message",
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
                    raise VisionProviderError(str(item), retryable=True) from item
                yield item
        finally:
            await worker_task


def provider_from_environment(provider_name: str | None = None) -> VisionProvider:
    provider = (provider_name or os.getenv("VISION_PROVIDER") or "dashscope").strip().lower()
    if provider == "dashscope":
        return DashscopeVisionProvider(
            api_url=os.getenv("DASHSCOPE_API_URL", ""),
            api_key=os.getenv("DASHSCOPE_API_KEY", ""),
            model=os.getenv("DASHSCOPE_IMAGE_MODEL", "qwen-vl-plus"),
        )
    raise VisionProviderError(f"Unsupported image recognition provider: {provider}", retryable=False)

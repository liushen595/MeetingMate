from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from typing import Any, AsyncIterator

import httpx


@dataclass(frozen=True)
class TextStreamChunk:
    content: str = ""
    reasoning_content: str = ""
    usage: dict[str, int] | None = None


class TextProviderError(Exception):
    def __init__(self, message: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.message = message
        self.retryable = retryable


class TextProvider:
    async def clean_transcript(self, text: str, language: str = "zh-CN") -> str:
        return local_clean_transcript(text)

    async def stream_json_completion(
        self,
        *,
        messages: list[dict[str, str]],
        response_format: dict[str, str],
        enable_thinking: bool,
    ) -> AsyncIterator[TextStreamChunk]:
        raise TextProviderError("Text generation provider does not support streaming chat completions.", retryable=False)
        yield TextStreamChunk()


def local_clean_transcript(text: str) -> str:
    content = text.strip()
    for token in ["嗯", "呃", "啊", "就是", "然后然后", "这个这个", "那个那个"]:
        content = content.replace(token, "")
    content = " ".join(content.split())
    return content


def object_get(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def content_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            text = object_get(item, "text")
            if text is not None:
                parts.append(str(text))
        return "".join(parts) if parts else None
    text = object_get(value, "text")
    return str(text) if text is not None else None


def extract_dashscope_text(response: Any) -> str | None:
    output = object_get(response, "output")
    direct_text = object_get(output, "text") if output is not None else None
    if direct_text is not None:
        return str(direct_text)
    choices = object_get(output, "choices") if output is not None else None
    if not choices:
        return None
    message = object_get(choices[0], "message")
    content = object_get(message, "content") if message is not None else None
    return content_text(content)


class DashscopeTextProvider(TextProvider):
    def __init__(self, *, api_url: str, compatible_base_url: str, api_key: str, model: str) -> None:
        self.api_url = api_url.rstrip("/")
        self.compatible_base_url = compatible_base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    async def clean_transcript(self, text: str, language: str = "zh-CN") -> str:
        if not self.api_key:
            raise TextProviderError("DASHSCOPE_API_KEY is not configured.", retryable=False)
        if not self.api_url:
            raise TextProviderError("DASHSCOPE_API_URL is not configured.", retryable=False)
        if not self.model:
            raise TextProviderError("DASHSCOPE_TEXT_MODEL is not configured.", retryable=False)
        try:
            import dashscope
        except ModuleNotFoundError as exc:
            raise TextProviderError("dashscope SDK is not installed.", retryable=False) from exc

        dashscope.base_http_api_url = self.api_url
        messages = [
            {
                "role": "system",
                "content": "你正在清理一段 ASR 转写文本。只删除口水词、无意义重复、明显停顿词和误触发内容。不要总结，不要扩写，不要改变原意，不要加入新信息。保留原本的语气和事实顺序。只输出清理后的文本。",
            },
            {
                "role": "user",
                "content": f"语言偏好：{language or 'zh-CN'}\n待清理文本：\n{text}",
            },
        ]

        def call_dashscope() -> str:
            response = dashscope.Generation.call(
                api_key=self.api_key,
                model=self.model,
                messages=messages,
                result_format="message",
            )
            result = extract_dashscope_text(response)
            if result is None:
                raise TextProviderError("DashScope text generation returned no text.", retryable=True)
            return result.strip()

        try:
            return await asyncio.to_thread(call_dashscope)
        except TextProviderError:
            raise
        except BaseException as exc:
            raise TextProviderError(str(exc), retryable=True) from exc

    async def stream_json_completion(
        self,
        *,
        messages: list[dict[str, str]],
        response_format: dict[str, str],
        enable_thinking: bool,
    ) -> AsyncIterator[TextStreamChunk]:
        if not self.api_key:
            raise TextProviderError("DASHSCOPE_API_KEY is not configured.", retryable=False)
        if not self.compatible_base_url:
            raise TextProviderError("DASHSCOPE_OPENAI_BASE_URL or DASHSCOPE_API_URL is not configured.", retryable=False)
        if not self.model:
            raise TextProviderError("DASHSCOPE_TEXT_MODEL is not configured.", retryable=False)

        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "response_format": response_format,
            "stream": True,
            "enable_thinking": enable_thinking,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        url = f"{self.compatible_base_url}/chat/completions"
        try:
            async with httpx.AsyncClient(timeout=600) as client:
                async with client.stream("POST", url, headers=headers, json=body) as response:
                    if response.status_code >= 400:
                        error_body = (await response.aread()).decode("utf-8", errors="replace")
                        retryable = response.status_code == 429 or response.status_code >= 500
                        raise TextProviderError(f"DashScope text generation failed: {error_body[:500]}", retryable=retryable)
                    async for line in response.aiter_lines():
                        chunk = parse_openai_sse_line(line)
                        if chunk is not None:
                            yield chunk
        except TextProviderError:
            raise
        except BaseException as exc:
            raise TextProviderError(str(exc), retryable=True) from exc


def compatible_dashscope_base_url(api_url: str) -> str:
    value = api_url.strip().rstrip("/")
    if not value:
        return ""
    if value.endswith("/compatible-mode/v1"):
        return value
    if value.endswith("/api/v1"):
        return value[: -len("/api/v1")] + "/compatible-mode/v1"
    return value + "/compatible-mode/v1"


def openai_usage(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    input_tokens = value.get("input_tokens", value.get("prompt_tokens", 0))
    output_tokens = value.get("output_tokens", value.get("completion_tokens", 0))
    try:
        return {"input_tokens": int(input_tokens or 0), "output_tokens": int(output_tokens or 0)}
    except (TypeError, ValueError):
        return {"input_tokens": 0, "output_tokens": 0}


def parse_openai_sse_line(line: str) -> TextStreamChunk | None:
    if not line.startswith("data:"):
        return None
    data = line.removeprefix("data:").strip()
    if not data or data == "[DONE]":
        return None
    try:
        payload = json.loads(data)
    except json.JSONDecodeError as exc:
        raise TextProviderError("DashScope text generation returned invalid stream JSON.", retryable=True) from exc
    usage = openai_usage(payload.get("usage"))
    choices = payload.get("choices")
    if not choices:
        return TextStreamChunk(usage=usage) if usage else None
    choice = choices[0]
    delta = object_get(choice, "delta") or {}
    reasoning_content = object_get(delta, "reasoning_content")
    content = object_get(delta, "content")
    return TextStreamChunk(
        content=str(content) if content is not None else "",
        reasoning_content=str(reasoning_content) if reasoning_content is not None else "",
        usage=usage,
    )


def provider_from_environment() -> TextProvider:
    api_url = os.getenv("DASHSCOPE_API_URL", "").strip()
    return DashscopeTextProvider(
        api_url=api_url,
        compatible_base_url=os.getenv("DASHSCOPE_OPENAI_BASE_URL", "").strip() or compatible_dashscope_base_url(api_url),
        api_key=os.getenv("DASHSCOPE_API_KEY", "").strip(),
        model=os.getenv("DASHSCOPE_TEXT_MODEL", "qwen-plus").strip() or "qwen-plus",
    )

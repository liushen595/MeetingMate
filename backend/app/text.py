from __future__ import annotations

import asyncio
import os
from typing import Any


class TextProviderError(Exception):
    def __init__(self, message: str, retryable: bool = True) -> None:
        self.message = message
        self.retryable = retryable


class TextProvider:
    async def clean_transcript(self, text: str, language: str = "zh-CN") -> str:
        return local_clean_transcript(text)


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
    def __init__(self, *, api_url: str, api_key: str, model: str) -> None:
        self.api_url = api_url.rstrip("/")
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


def provider_from_environment() -> TextProvider:
    return DashscopeTextProvider(
        api_url=os.getenv("DASHSCOPE_API_URL", "").strip(),
        api_key=os.getenv("DASHSCOPE_API_KEY", "").strip(),
        model=os.getenv("DASHSCOPE_TEXT_MODEL", "qwen-plus").strip() or "qwen-plus",
    )

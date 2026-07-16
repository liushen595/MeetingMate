from __future__ import annotations

import asyncio
import base64
import json
import os
import queue
import re
from dataclasses import dataclass
from typing import Any, AsyncIterator


DASHSCOPE_MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024
MAX_CAPTION_CHARS = 80
DEFAULT_IMAGE_RECOGNITION_PROMPT = """
请识别这张图片，使用中文输出。

只输出 JSON，不要输出 Markdown，不要输出解释。

caption 是一句简洁中文图片说明，最多 40 字。
text 是图片中可读文字、白板要点、图表关系和待办事项的纯文本整理。
text 不要重复 caption。
text 不要使用 Markdown 语法，不要使用 #、-、*、```、Markdown 表格。
如果需要分点，使用普通换行，或使用“1. 内容”这种纯文本编号。
如果没有可提取正文内容，text 返回空字符串。
不要编造看不见的信息。

返回格式：
{"caption":"","text":""}
""".strip()


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
        prompt: str | None = None,
    ) -> VisionResult:
        text = ""
        async for chunk in self.stream_recognize(
            filename=filename,
            content_type=content_type,
            content=content,
            width=width,
            height=height,
            language=language,
            prompt=prompt,
        ):
            text = append_stream_text(text, chunk)
        if prompt is not None:
            return raw_result_from_text(text)
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
        prompt: str | None = None,
    ) -> AsyncIterator[str]:
        result = await self.recognize(
            filename=filename,
            content_type=content_type,
            content=content,
            width=width,
            height=height,
            language=language,
            prompt=prompt,
        )
        if prompt is not None:
            if result.text:
                yield result.text
            return
        result = normalize_result(result)
        yield json.dumps({"caption": result.caption, "text": result.text}, ensure_ascii=False)


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
            return value[:MAX_CAPTION_CHARS]
    return ""


def strip_json_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    if len(lines) >= 2 and lines[0].strip().startswith("```") and lines[-1].strip() == "```":
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


def string_field(value: Any) -> str:
    return value if isinstance(value, str) else ""


def collapse_blank_lines(text: str) -> str:
    lines: list[str] = []
    previous_blank = False
    for line in text.splitlines():
        value = line.rstrip()
        if not value.strip():
            if lines and not previous_blank:
                lines.append("")
            previous_blank = True
            continue
        lines.append(value)
        previous_blank = False
    return "\n".join(lines).strip()


def clean_markdown_text(text: str) -> str:
    normalized = text.strip().replace("\r\n", "\n").replace("\r", "\n")
    if not normalized:
        return ""
    lines: list[str] = []
    for line in normalized.splitlines():
        value = line.strip()
        if not value:
            lines.append("")
            continue
        if value.startswith("```"):
            continue
        if re.fullmatch(r"\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?", value):
            continue
        if re.fullmatch(r"[-*_]{3,}", value):
            continue
        value = re.sub(r"^#{1,6}\s*", "", value)
        value = re.sub(r"^>\s?", "", value)
        value = re.sub(r"^[-*+]\s+", "", value)
        if value.startswith("|") and value.endswith("|") and value.count("|") >= 2:
            cells = [cell.strip() for cell in value.strip("|").split("|")]
            value = "\t".join(cell for cell in cells if cell)
        value = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", value)
        value = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", value)
        value = value.replace("```", "").replace("`", "")
        value = value.replace("**", "").replace("__", "")
        value = re.sub(r"(?<!\w)\*([^*\n]+)\*(?!\w)", r"\1", value)
        value = re.sub(r"(?<!\w)_([^_\n]+)_(?!\w)", r"\1", value)
        lines.append(value.strip())
    return collapse_blank_lines("\n".join(lines))


def clean_caption(caption: str) -> str:
    cleaned = clean_markdown_text(caption).replace("\n", " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:MAX_CAPTION_CHARS].rstrip()


def comparison_key(value: str) -> str:
    return re.sub(r"[\W_]+", "", value, flags=re.UNICODE).lower()


def line_repeats_caption(line: str, caption: str) -> bool:
    line_without_label = re.sub(r"^(?:caption|图片说明|图片描述|简洁说明|说明)[:：]\s*", "", line.strip(), flags=re.IGNORECASE)
    line_key = comparison_key(line_without_label)
    caption_key = comparison_key(caption)
    if not line_key or not caption_key:
        return False
    if line_key == caption_key:
        return True
    return caption_key in line_key and len(line_key) <= max(len(caption_key) + 8, len(caption_key) * 2)


def remove_repeated_caption_line(text: str, caption: str) -> str:
    cleaned = collapse_blank_lines(text)
    if not cleaned or not caption:
        return cleaned
    lines = cleaned.splitlines()
    if lines and line_repeats_caption(lines[0], caption):
        lines = lines[1:]
    return collapse_blank_lines("\n".join(lines))


def parse_image_json_result(text: str) -> tuple[VisionResult | None, bool]:
    json_object = extract_json_object(text)
    if json_object is None:
        return None, False
    try:
        payload = json.loads(json_object)
    except json.JSONDecodeError:
        return VisionResult(caption="", text=""), True
    if not isinstance(payload, dict):
        return VisionResult(caption="", text=""), True
    caption = clean_caption(string_field(payload.get("caption")))
    body = remove_repeated_caption_line(clean_markdown_text(string_field(payload.get("text"))), caption)
    return VisionResult(caption=caption, text=body), True


def result_from_text(text: str) -> VisionResult:
    raw = text.strip()
    if not raw:
        return VisionResult(caption="", text="")
    parsed, valid_json = parse_image_json_result(raw)
    if parsed is not None:
        return parsed
    if valid_json:
        return VisionResult(caption="", text="")
    caption = clean_caption(first_nonempty_line(raw))
    body = remove_repeated_caption_line(clean_markdown_text(raw), caption)
    return VisionResult(caption=caption, text=body)


def normalize_result(result: VisionResult) -> VisionResult:
    caption = clean_caption(result.caption)
    parsed, valid_json = parse_image_json_result(result.text)
    if parsed is not None:
        caption = parsed.caption or caption
        return VisionResult(caption=caption, text=remove_repeated_caption_line(parsed.text, caption))
    if valid_json:
        return VisionResult(caption=caption, text="")
    body = remove_repeated_caption_line(clean_markdown_text(result.text), caption)
    if not caption:
        caption = clean_caption(first_nonempty_line(result.text))
        body = remove_repeated_caption_line(body, caption)
    return VisionResult(caption=caption, text=body)


def default_image_prompt() -> str:
    return DEFAULT_IMAGE_RECOGNITION_PROMPT


def build_image_prompt(prompt: str | None, language: str, width: int | None, height: int | None) -> str:
    request_prompt = prompt or default_image_prompt()
    if language:
        request_prompt += f"\n用户语言偏好：{language}。"
    if width and height:
        request_prompt += f"\n图片尺寸：{width}x{height}。"
    return request_prompt


def raw_result_from_text(text: str) -> VisionResult:
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
        prompt: str | None = None,
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
        request_prompt = build_image_prompt(prompt, language, width, height)
        messages = [{"role": "user", "content": [{"image": data_uri}, {"text": request_prompt}]}]
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

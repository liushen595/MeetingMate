from __future__ import annotations

import argparse
import base64
import os
import pathlib
import sys
from typing import Any

import dashscope
from dotenv import load_dotenv


MAX_BASE64_BYTES = 10 * 1024 * 1024
BACKEND_ROOT = pathlib.Path(__file__).resolve().parents[1]


def object_get(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def extract_text(response: Any) -> str | None:
    output = object_get(response, "output")
    choices = object_get(output, "choices") if output is not None else None
    if not choices:
        return None
    message = object_get(choices[0], "message")
    content = object_get(message, "content") if message is not None else None
    if not content:
        return None
    text = object_get(content[0], "text")
    return str(text) if text is not None else None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Encode a local audio file as Base64 and call DashScope ASR.")
    parser.add_argument("audio", type=pathlib.Path, help="Local audio file path, for example ../test.m4a")
    parser.add_argument("--mime", default="audio/mp4", help="Audio MIME type. Default: audio/mp4")
    parser.add_argument("--model", default=None, help="DashScope ASR model name. Default: DASHSCOPE_MODEL or qwen3-asr-flash")
    parser.add_argument("--language", default="zh", help="ASR language option. Default: zh")
    parser.add_argument("--env-file", type=pathlib.Path, default=BACKEND_ROOT / ".env", help="Env file path. Default: backend/.env")
    parser.add_argument("--no-stream", action="store_true", help="Use non-streaming API call")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    env_file = args.env_file.expanduser().resolve()
    if env_file.exists():
        load_dotenv(env_file)
    else:
        print(f"Env file does not exist, falling back to current shell env: {env_file}", file=sys.stderr)

    api_url = os.getenv("DASHSCOPE_API_URL")
    api_key = os.getenv("DASHSCOPE_API_KEY")
    model = args.model or os.getenv("DASHSCOPE_MODEL", "qwen3-asr-flash")
    if not api_url:
        print("DASHSCOPE_API_URL is not set in .env or the current shell.", file=sys.stderr)
        return 2
    if not api_key:
        print("DASHSCOPE_API_KEY is not set in .env or the current shell.", file=sys.stderr)
        return 2

    audio_path = args.audio.expanduser().resolve()
    if not audio_path.exists():
        print(f"Audio file does not exist: {audio_path}", file=sys.stderr)
        return 2

    content = audio_path.read_bytes()
    encoded = base64.b64encode(content)
    if len(encoded) > MAX_BASE64_BYTES:
        print(
            f"Base64 payload is too large: {len(encoded)} bytes > {MAX_BASE64_BYTES} bytes.",
            file=sys.stderr,
        )
        return 2

    dashscope.base_http_api_url = api_url.rstrip("/")
    data_uri = f"data:{args.mime};base64,{encoded.decode('ascii')}"
    messages = [{"role": "user", "content": [{"audio": data_uri}]}]
    call_kwargs = {
        "api_key": api_key,
        "model": model,
        "messages": messages,
        "result_format": "message",
        "asr_options": {"language": args.language, "enable_itn": False},
    }

    print(f"audio: {audio_path}")
    print(f"raw_bytes: {len(content)}")
    print(f"base64_bytes: {len(encoded)}")
    print(f"api_url: {api_url.rstrip('/')}")
    print(f"model: {model}")
    print("transcript:")

    try:
        if args.no_stream:
            response = dashscope.MultiModalConversation.call(**call_kwargs)
            text = extract_text(response)
            print(text or "")
            return 0 if text else 1

        transcript = ""
        responses = dashscope.MultiModalConversation.call(**call_kwargs, stream=True)
        for response in responses:
            text = extract_text(response)
            if not text:
                continue
            if text.startswith(transcript):
                delta = text[len(transcript) :]
                transcript = text
            else:
                delta = text
                transcript += text
            if delta:
                print(delta, end="", flush=True)
        print()
        return 0 if transcript else 1
    except Exception as exc:
        print(f"DashScope ASR request failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

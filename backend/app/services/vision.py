"""Screen frame -> structured events, using a vision model on Nebius Token Factory.

Nebius is OpenAI-compatible, so we use the OpenAI client with our base URL and key.
"""

import base64
import json
import re
import time
from dataclasses import dataclass, field

from openai import AsyncOpenAI

from ..config import settings
from ..prompts import load_prompt


@dataclass
class VisionResult:
    screen_summary: str = ""
    events: list[dict] = field(default_factory=list)
    latency_ms: int = 0
    model: str = ""
    usage: dict = field(default_factory=dict)
    raw: str = ""
    parse_ok: bool = True


def get_client() -> AsyncOpenAI:
    return AsyncOpenAI(base_url=settings.nebius_base_url, api_key=settings.nebius_api_key, timeout=30.0)


def parse_json_object(text: str) -> dict:
    """Parse a JSON object from model output. Tolerates code fences and surrounding prose."""
    text = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, flags=re.S)
    if fence:
        text = fence.group(1)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            return json.loads(text[start : end + 1])
        raise


async def extract_events(
    image_bytes: bytes,
    prev_summary: str = "",
    *,
    mime: str = "image/jpeg",
    model: str | None = None,
    client: AsyncOpenAI | None = None,
) -> VisionResult:
    """Send one frame to the vision model and return the events it reports."""
    client = client or get_client()
    model = model or settings.nebius_vlm_model
    data_url = f"data:{mime};base64,{base64.b64encode(image_bytes).decode()}"

    # GLM models "think" before answering, which adds many seconds per frame. Turn it off for GLM.
    extra_body = {"chat_template_kwargs": {"enable_thinking": False}} if "glm" in model.lower() else None

    t0 = time.perf_counter()
    resp = await client.chat.completions.create(
        model=model,
        temperature=0,
        max_tokens=1200,
        extra_body=extra_body,
        messages=[
            {"role": "system", "content": load_prompt("vision_events")},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"PREVIOUS_SCREEN: {prev_summary or '(none, first frame)'}"},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
    )
    latency_ms = int((time.perf_counter() - t0) * 1000)

    raw = resp.choices[0].message.content or ""
    usage = resp.usage.model_dump() if resp.usage else {}
    try:
        data = parse_json_object(raw)
        return VisionResult(
            screen_summary=str(data.get("screen_summary", "")),
            events=list(data.get("events", [])),
            latency_ms=latency_ms,
            model=model,
            usage=usage,
            raw=raw,
        )
    except (json.JSONDecodeError, TypeError):
        return VisionResult(latency_ms=latency_ms, model=model, usage=usage, raw=raw, parse_ok=False)

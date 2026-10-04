"""Text-only JSON calls to the Nebius model (same client approach as services/vision.py).

Used by the question planner and the skill synthesizer. Callers decide how to degrade on failure.
"""

import json
from dataclasses import dataclass

from openai import AsyncOpenAI

from ..config import text_model
from .vision import get_client, parse_json_object


@dataclass
class JsonReply:
    data: dict | None  # None when the output was not parseable JSON
    raw: str = ""
    model: str = ""


def no_thinking_options(model: str) -> dict | None:
    """Keep reasoning models from spending the whole token budget on hidden thinking (empty answer, slow).

    Measured on the Nebius endpoint with the planner prompt (see PR): with max_tokens=600 both default
    models returned an EMPTY answer (all tokens went to reasoning). These switches fix that:
    - DeepSeek: chat_template_kwargs {"thinking": false}  (1.2 s, 0 reasoning tokens)
    - GLM: reasoning_effort "low"  (1.4 s). GLM's `enable_thinking: false` (used in vision.py) did NOT work for text.
    """
    name = model.lower()
    if "deepseek" in name:
        return {"chat_template_kwargs": {"thinking": False}}
    if "glm" in name:
        return {"reasoning_effort": "low"}
    return None


async def chat_json(
    system: str,
    user: str,
    *,
    max_tokens: int = 1500,
    model: str | None = None,
    client: AsyncOpenAI | None = None,
) -> JsonReply:
    """One chat call that must answer with a JSON object. Raises on transport errors (callers catch)."""
    client = client or get_client()
    model = model or text_model()
    extra_body = no_thinking_options(model)
    resp = await client.chat.completions.create(
        model=model,
        temperature=0,
        max_tokens=max_tokens,
        extra_body=extra_body,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
    )
    raw = resp.choices[0].message.content or ""
    try:
        data = parse_json_object(raw)
    except (json.JSONDecodeError, TypeError):
        return JsonReply(None, raw, model)
    return JsonReply(data if isinstance(data, dict) else None, raw, model)

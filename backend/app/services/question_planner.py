"""What should Yoda ask? Uses the prompt in prompts/question_planner.system.md.

The browser's pause controller decides WHEN to ask. This only proposes candidates. Any failure (timeout,
transport error, bad JSON) gives an empty list, never an exception.
"""

import asyncio
import json
import logging
import re
import uuid

from ..config import settings
from ..prompts import load_prompt
from ..schemas import QuestionCandidate
from . import llm
from .gaps import similar

log = logging.getLogger("padawan.planner")

MAX_CANDIDATES = 3
VALID_TYPES = {"reason", "guardrail", "limit", "exception"}


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", text.lower()).strip()


def build_user_message(events: list[dict], transcript: list[dict], asked: list[dict]) -> str:
    guardrails = sum(1 for q in asked if q.get("type") in ("guardrail", "limit"))
    ev = [
        {k: e.get(k) for k in ("id", "t_ms", "kind", "summary", "entities", "salient") if k in e}
        for e in events
    ]
    lines = [f"[{u.get('t_ms', 0)} ms] {u.get('speaker', 'expert')}: {u.get('text', '')}" for u in transcript]
    return (
        f"RECENT_EVENTS: {json.dumps(ev, ensure_ascii=False)}\n"
        f"RECENT_TRANSCRIPT:\n{chr(10).join(lines) or '(nothing said yet)'}\n"
        f"ALREADY_ASKED: {json.dumps([q.get('text', '') for q in asked], ensure_ascii=False)}\n"
        f"GUARDRAIL_COUNT: {guardrails}"
    )


def parse_candidates(data: dict | None, valid_event_ids: set[int], asked: list[dict]) -> list[QuestionCandidate]:
    """Keep only well-formed candidates anchored to a real event, not repeating an earlier question."""
    if not data or not isinstance(data.get("candidates"), list):
        return []
    seen = {_norm(q.get("text", "")) for q in asked}
    out: list[QuestionCandidate] = []
    for raw in data["candidates"]:
        try:
            qtype = str(raw["type"]).strip().lower()
            text = str(raw["text"]).strip()
            anchor = int(raw["anchor_event_id"])
            priority = min(1.0, max(0.0, float(raw.get("priority", 0.5))))
        except (KeyError, TypeError, ValueError):
            continue
        if qtype not in VALID_TYPES or not text or anchor not in valid_event_ids or _norm(text) in seen:
            continue
        seen.add(_norm(text))
        out.append(
            QuestionCandidate(id=str(uuid.uuid4()), type=qtype, text=text, anchor_event_id=anchor, priority=priority)
        )
    out.sort(key=lambda c: c.priority, reverse=True)
    # Same (type, anchor) or a near-identical wording within one batch: keep the best only.
    final: list[QuestionCandidate] = []
    for c in out:
        if any((f.type, f.anchor_event_id) == (c.type, c.anchor_event_id) or similar(f.text, c.text) for f in final):
            continue
        if any(similar(q.get("text", ""), c.text) for q in asked):
            continue
        final.append(c)
    return final[:MAX_CANDIDATES]


async def plan_questions(
    events: list[dict],
    transcript: list[dict],
    asked: list[dict],
    *,
    chat=llm.chat_json,
    timeout_s: float | None = None,
) -> list[QuestionCandidate]:
    """Candidates for the next pause, best first. Empty on any failure."""
    ids = {int(e["id"]) for e in events if "id" in e}
    if not ids:
        return []
    if chat is llm.chat_json and not settings.nebius_api_key:
        return []  # no key (local UI work): skip quietly instead of failing on every salient frame
    try:
        reply = await asyncio.wait_for(
            chat(load_prompt("question_planner"), build_user_message(events, transcript, asked), max_tokens=600),
            timeout=timeout_s if timeout_s is not None else settings.planner_timeout_s,
        )
    except asyncio.TimeoutError:
        log.warning("question planner timed out")
        return []
    except Exception:
        log.exception("question planner failed")
        return []
    return parse_candidates(reply.data, ids, asked)

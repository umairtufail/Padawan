"""Learn mode guardrail checker: is the learner about to break a guardrail? Prompt: prompts/guardrail_checker.system.md.

One text-only model call per frame that has new events (same approach as the question planner). It must never
break the stream: a timeout, a transport error or an unparseable answer gives verdict "ok" (degraded=True).

The model proposes, this module disposes (conservative on purpose, a false stop is worse than a late one):
- the guardrail id must exist in the skill, else the verdict is "ok";
- "stop" needs `settings.guardrail_stop_confidence` and a guardrail id, else it drops to "warn" (or "ok" below 0.5);
- a move that was already saved/posted (`committed`) is never a "stop", it becomes "warn".
"""

import asyncio
import json
import logging
from dataclasses import dataclass

from ..config import settings
from ..prompts import load_prompt
from ..schemas import Guardrail, SkillJson
from . import llm

log = logging.getLogger("padawan.guardrail")

WARN_MIN_CONFIDENCE = 0.5
MAX_REASON_CHARS = 300


@dataclass
class CheckResult:
    verdict: str = "ok"  # ok | warn | stop
    step_idx: int | None = None
    guardrail_id: str | None = None
    confidence: float = 0.0
    committed: bool = False
    reason: str = ""
    evidence: str = ""
    degraded: bool = False


def guardrail_index(skill: SkillJson) -> dict[str, tuple[Guardrail, int | None]]:
    """guardrail id -> (guardrail, step idx it belongs to, None for a global one)."""
    out: dict[str, tuple[Guardrail, int | None]] = {}
    for s in skill.steps:
        for g in s.guardrails:
            out[g.id] = (g, s.idx)
    for g in skill.global_guardrails:
        out.setdefault(g.id, (g, None))
    return out


def build_user_message(skill: SkillJson, current_step_idx: int, screen_summary: str, events: list[dict]) -> str:
    def g(x: Guardrail) -> dict:
        return {"id": x.id, "type": x.type, "rule": x.rule}

    payload = {
        "SKILL": {
            "title": skill.title,
            "language": skill.language,
            "steps": [
                {
                    "idx": s.idx, "title": s.title, "decision": s.decision.summary,
                    "decision_type": s.decision.type, "reason": s.reason.text if s.reason else None,
                    "guardrails": [g(x) for x in s.guardrails],
                }
                for s in skill.steps
            ],
        },
        "GLOBAL_GUARDRAILS": [g(x) for x in skill.global_guardrails],
        "CURRENT_STEP": current_step_idx,
        "SCREEN_NOW": screen_summary,
        "NEWEST_EVENTS": [
            {k: e.get(k) for k in ("id", "t_ms", "kind", "summary", "entities", "visible_text") if k in e} for e in events
        ],
    }
    return json.dumps(payload, ensure_ascii=False)


def interpret(data: dict | None, skill: SkillJson, current_step_idx: int) -> CheckResult:
    """Turn the model's JSON into a safe verdict. Anything malformed or unsupported means ok."""
    ok = CheckResult(step_idx=current_step_idx)
    if not isinstance(data, dict):
        return CheckResult(step_idx=current_step_idx, degraded=True)
    valid_steps = {s.idx for s in skill.steps}
    try:
        step_idx = int(data.get("step_idx", current_step_idx))
    except (TypeError, ValueError):
        step_idx = current_step_idx
    if step_idx not in valid_steps:
        step_idx = current_step_idx
    ok.step_idx = step_idx

    verdict = str(data.get("verdict", "ok")).strip().lower()
    if verdict not in ("warn", "stop"):
        return ok
    try:
        confidence = min(1.0, max(0.0, float(data.get("confidence", 0.0))))
    except (TypeError, ValueError):
        return ok
    raw_id = data.get("guardrail_id")
    gid = str(raw_id).strip() if raw_id not in (None, "", "null") else None
    if gid is not None and gid not in guardrail_index(skill):
        return ok  # the model invented a rule: ignore the whole verdict
    committed = data.get("committed") is True
    reason = str(data.get("reason") or "").strip()[:MAX_REASON_CHARS]
    if not reason:
        return ok  # nothing to say to the learner

    if verdict == "stop" and (committed or gid is None or confidence < settings.guardrail_stop_confidence):
        verdict = "warn"
    if verdict == "warn" and confidence < WARN_MIN_CONFIDENCE:
        return ok
    return CheckResult(
        verdict=verdict, step_idx=step_idx, guardrail_id=gid, confidence=round(confidence, 2), committed=committed,
        reason=reason, evidence=str(data.get("evidence") or "")[:200],
    )


async def check_move(
    skill: SkillJson,
    current_step_idx: int,
    screen_summary: str,
    events: list[dict],
    *,
    chat=llm.chat_json,
    timeout_s: float | None = None,
) -> CheckResult:
    """The verdict for the newest events. Never raises."""
    if not events or not skill.steps:
        return CheckResult(step_idx=current_step_idx)
    if chat is llm.chat_json and not settings.nebius_api_key:
        return CheckResult(step_idx=current_step_idx, degraded=True)
    try:
        reply = await asyncio.wait_for(
            chat(
                load_prompt("guardrail_checker"),
                build_user_message(skill, current_step_idx, screen_summary, events),
                max_tokens=500,
            ),
            timeout=timeout_s if timeout_s is not None else settings.guardrail_timeout_s,
        )
    except asyncio.TimeoutError:
        log.warning("guardrail checker timed out")
        return CheckResult(step_idx=current_step_idx, degraded=True)
    except Exception:
        log.exception("guardrail checker failed")
        return CheckResult(step_idx=current_step_idx, degraded=True)
    try:
        return interpret(reply.data, skill, current_step_idx)
    except Exception:
        log.exception("guardrail verdict could not be interpreted")
        return CheckResult(step_idx=current_step_idx, degraded=True)
